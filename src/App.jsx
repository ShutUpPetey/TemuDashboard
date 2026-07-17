import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";

import { storage } from "./lib/storage";
import { downloadCsv, itemsCsv, ordersCsv } from "./lib/exportCsv";
import { applyDiscounts } from "./lib/discounts";
import { callClaude, cancelCurrentCall, textOf, extractJSON, getApiKey, setApiKey, recordUsage, estimateCostPerCall } from "./lib/anthropic";
import { getToken, getStoredToken, isSignedIn, hasConsented, signIn, signOut } from "./lib/gis";
import { cloudConfigured, cloudSignIn, cloudSignOut, cloudRestore, cloudGet, cloudSet, cloudSubscribe, cloudSubscribeCarrier, cloudClockSkew, cloudListDirectory, cloudGetUserState, pushConfigured, pushSupported, pushLocallyEnabled, pushEnable, pushDisable, pushRefresh, pushOnForeground } from "./lib/firebase";
import {
  searchMessages, getMessageMetadata, getMessageFull, headerValue,
  extractHtml, extractSection, extractAllSections, extractImgSrcs, extractPoNumber, extractSubOrders,
  extractOrderLink, extractEta, isOrderDetailLink, extractPoFromBody, extractTracking,
} from "./lib/gmail";
import { buildStats, reviewQueue, inTransitOrders, isActiveStatus, analyticsItemKey, freeItems, ratingQueues, remapRatingsAfterReplace } from "./lib/derive";
import { mergeState, remoteIsStale, sameOrderSet, remoteRatingsStale, sameRatingSet, remoteUnmatchedStale, sameUnmatchedSet } from "./lib/syncMerge";
import { CATEGORIES, fmt, numOrNull, annotateThumbs, Lightbox, THUMB_SIZE_KEY, THUMB_SIZE_DEFAULT } from "./components/shared";
import { useLayoutMode } from "./hooks/useMediaQuery";
import DesktopShell from "./components/DesktopShell";
import MobileShell from "./components/MobileShell";
import WelcomeModal from "./components/WelcomeModal";

/* ============================================================
   Temu Order Manifest — syncs Gmail directly (Google OAuth + REST),
   reads Temu's image-rendered receipts via Claude vision (user's own
   API key, called browser-direct), distributes discounts
   proportionally, and runs spend analytics.

   This file is the DATA ENGINE: state, sync, parsing, storage,
   exports, edits. Presentation lives in two adaptive shells —
   components/DesktopShell.jsx ("command center", ≥768px) and
   components/MobileShell.jsx ("visual gallery", phones) — chosen by
   viewport width or the Settings → Layout override. Both consume the
   same ctx object built at the bottom of this component.
   ============================================================ */

const STORAGE_KEY = "temu-manifest-v1";
const WELCOME_SEEN_KEY = "temu-manifest-welcome-seen-v1";
// Per-device, analytics-only "ignore this item" list (e.g. a one-off
// expensive gift that skews spend stats) — deliberately local-only like
// thumbSize, not synced to Firebase or IndexedDB: it's a view preference,
// not order data, and never hides the item anywhere outside Analytics.
const ANALYTICS_IGNORE_KEY = "temu-analytics-ignore-v1";
// The one Google account allowed to see the admin directory / "view as"
// panel — everyone else's manifest/{uid} subtree is invisible to them per
// the Firebase rules in README → "Admin access". Unset = admin view is
// simply never shown to anyone (single-user mode, the historical default).
const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL || null;

export default function App() {
  const [data, setData] = useState({ orders: [], processedIds: [], lastSync: null, autoSync: true, ratings: {}, unmatchedStatus: [] });
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [log, setLog] = useState([]);
  const [query, setQuery] = useState("");
  const [lightbox, setLightbox] = useState(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState(() => getApiKey());
  const [googleSignedIn, setGoogleSignedIn] = useState(() => isSignedIn());
  const [failedEmails, setFailedEmails] = useState([]);
  // NOTE: unmatchedStatus (status emails with no matching order) used to be
  // session-only React state here. It now lives IN the persisted data blob
  // (data.unmatchedStatus) so the headless gmail-sync Action's findings show
  // up in the Review queue too, and survive reloads — see the sync() status
  // pass, importMissingOrder, and lib/syncMerge.js's mergeUnmatchedStatus.
  const [thumbSize, setThumbSize] = useState(() => Number(localStorage.getItem(THUMB_SIZE_KEY)) || THUMB_SIZE_DEFAULT);
  const [ignoredAnalytics, setIgnoredAnalytics] = useState(() => {
    try { return JSON.parse(localStorage.getItem(ANALYTICS_IGNORE_KEY) || "[]"); } catch { return []; }
  });
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const cancelRequestedRef = useRef(false);
  const { mode, override: layoutOverride, setLayoutOverride } = useLayoutMode();

  /* ----- cloud sync (optional Firebase RTDB) -----
     "unconfigured" = no VITE_FIREBASE_* env vars, feature invisible.
     "off" → "connecting" → "on" | "error" once configured. */
  const [cloudState, setCloudState] = useState(() => (cloudConfigured() ? "off" : "unconfigured"));
  const [cloudDirty, setCloudDirty] = useState(false); // a save landed while cloud sync wasn't connected — local-only until reconnect
  const [carrier, setCarrier] = useState({}); // trackingNumber → live 17TRACK info (from the GitHub Action)
  const [cloudEmail, setCloudEmail] = useState(null); // signed-in Firebase user's email, once connected

  /* ----- push notifications (optional FCM, per-device) -----
     pushEnabled mirrors the localStorage marker (lib/firebase.js) so the
     Settings toggle survives reloads; pushSupport is the async browser-
     capability probe (null = still checking). All of it is inert unless
     VITE_FIREBASE_MESSAGING_SENDER_ID + VITE_FIREBASE_VAPID_KEY are set. */
  const [pushEnabled, setPushEnabled] = useState(() => pushLocallyEnabled());
  const [pushBusy, setPushBusy] = useState(false);
  const [pushSupport, setPushSupport] = useState(null);
  const pushFgUnsubRef = useRef(null); // foreground onMessage unsubscribe

  /* ----- admin: read-only "view as user" (see AdminPanel.jsx) -----
     directory: {uid: {email, lastSeen}} for every registered user, loaded
     on demand when the admin opens the panel. adminViewUid/adminViewState
     hold whichever OTHER user's data is currently being viewed — kept
     completely separate from `data`/`save()` so there is no code path by
     which viewing someone else's data could write to their tree (or the
     admin's own tree gets confused with theirs). */
  const [directory, setDirectory] = useState(null);
  const [directoryError, setDirectoryError] = useState(null);
  const [adminViewUid, setAdminViewUid] = useState(null);
  const [adminViewState, setAdminViewState] = useState(null);
  const [adminViewLoading, setAdminViewLoading] = useState(false);
  const cloudReadyRef = useRef(false);      // gate write-through in save()
  const cloudConnectRef = useRef(null);     // the in-flight/settled connect() promise — idempotent AND awaitable
  const cloudUnsubRef = useRef(null);
  const cloudCarrierUnsubRef = useRef(null);
  const dataRef = useRef(null);             // latest data, for callbacks — written SYNCHRONOUSLY at every mutation (see save)
  const pendingRemoteRef = useRef(null);    // remote payload that arrived mid-sync, replayed when the sync ends
  const syncingRef = useRef(false);

  // 400 lines so a full Reconcile's failures don't scroll away; the log
  // panel has a download button for offline inspection.
  const pushLog = (msg, kind = "info") =>
    setLog((l) => [...l.slice(-400), { t: new Date().toLocaleTimeString(), msg, kind }]);

  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { syncingRef.current = syncing; }, [syncing]);

  /* Esc closes the image lightbox */
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => { if (e.key === "Escape") setLightbox(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const updateThumbSize = useCallback((v) => {
    setThumbSize(v);
    localStorage.setItem(THUMB_SIZE_KEY, String(v));
  }, []);

  const toggleIgnoreAnalyticsItem = useCallback((key) => {
    setIgnoredAnalytics((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      localStorage.setItem(ANALYTICS_IGNORE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  /* ----- load / save ----- */
  useEffect(() => {
    (async () => {
      try {
        const r = await storage.get(STORAGE_KEY);
        if (r?.value) setData((d) => ({ ...d, ...JSON.parse(r.value) }));
      } catch { /* first run */ }
      try {
        const w = await storage.get(WELCOME_SEEN_KEY);
        if (!w?.value) setShowWelcome(true); // first-ever load — no seen flag yet
      } catch { /* if this fails, better to show it than silently skip */ setShowWelcome(true); }
      setLoaded(true);
    })();
  }, []);

  /* First-run tour: shown automatically once, re-launchable anytime from
     Settings (openWelcome doesn't touch the persisted flag). */
  const closeWelcome = useCallback(() => {
    setShowWelcome(false);
    storage.set(WELCOME_SEEN_KEY, "1").catch(() => {});
  }, []);
  const openWelcome = useCallback(() => setShowWelcome(true), []);

  const save = useCallback(async (next) => {
    // updatedAt is the whole-blob version for cloud newest-wins resolution.
    const stamped = { ...next, updatedAt: Date.now() };
    // dataRef is written synchronously (not just via the post-render effect)
    // so two mutations in the same tick — e.g. two quick edits, or a save
    // racing the carrier-promote effect — build on each other instead of
    // both building on the same stale render closure and one silently
    // dropping the other. Mutation handlers read dataRef.current, never
    // the `data` closure, for the same reason.
    dataRef.current = stamped;
    setData(stamped);
    const json = JSON.stringify(stamped);
    try { await storage.set(STORAGE_KEY, json); }
    catch (e) { pushLog("Save failed: " + e.message, "error"); }
    if (cloudReadyRef.current) {
      cloudSet(json, stamped.updatedAt)
        .then(() => setCloudDirty(false))
        .catch((e) => {
          // The change is safe locally but did NOT reach Firebase — that's
          // a visible problem now (CloudBanner), not just a log line the
          // user finds a week later when their phone shows stale data.
          setCloudDirty(true);
          setCloudState("error");
          pushLog("Cloud save FAILED — this change is on this device only until sync reconnects: " + e.message, "error");
        });
    } else if (cloudConfigured()) {
      // Cloud sync is configured but not connected (signed out, session
      // expired, or an earlier error). The save persists locally, but the
      // user needs to know it isn't syncing — CloudBanner keys off
      // cloudDirty for exactly this moment.
      setCloudDirty(true);
      pushLog("Saved on this device only — cloud sync isn't connected. Use the banner or Settings → Google to reconnect.", "warn");
    }
  }, []);

  /* Apply a remote cloud payload to local state via the per-order merge.
     Shared by the live listener and by the after-sync replay of a payload
     that arrived while a sync was running. */
  const applyRemote = useCallback((val, note) => {
    try {
      const parsed = JSON.parse(val.json);
      const localNow = dataRef.current || {};
      const merged = mergeState(localNow, parsed);
      // ALL fingerprints must agree nothing changed — a ratings-only
      // remote edit leaves merged.orders identical to localNow.orders, so
      // checking orders alone would silently drop it (see lib/syncMerge.js
      // "Ratings merge" header). Same for unmatchedStatus: a headless
      // gmail-sync run that only found new UNMATCHED status emails changes
      // neither orders nor ratings, and its findings must still land here
      // or they'd never reach the Review queue.
      if (sameOrderSet(merged.orders, localNow.orders || []) && sameRatingSet(merged.ratings, localNow.ratings || {}) && sameUnmatchedSet(merged.unmatchedStatus, localNow.unmatchedStatus || [])) return; // our own echo, or nothing new
      dataRef.current = merged; // synchronous, so callbacks never see pre-merge state
      setData(merged);
      storage.set(STORAGE_KEY, JSON.stringify(merged)).catch(() => {});
      if (remoteIsStale(merged.orders, parsed.orders) || remoteRatingsStale(merged.ratings, parsed.ratings) || remoteUnmatchedStale(merged.unmatchedStatus, parsed.unmatchedStatus)) {
        cloudSet(JSON.stringify(merged), merged.updatedAt).catch(() => {});
      }
      pushLog(note, "ok");
    } catch { /* malformed remote payload — ignore */ }
  }, []);

  /* Connect the optional Firebase layer using the SAME Google access token
     the app already holds for Gmail. Pull-newer on connect, then live
     listener. Idempotent (one shared promise) and AWAITABLE — sync() must
     await it before snapshotting state, so the initial cloud merge lands
     in dataRef before the sync loop starts saving; otherwise the loop
     would push a pre-merge snapshot over both local state and the cloud
     blob, wiping edits that so far existed only in the cloud copy. */
  const connectCloud = useCallback((token) => {
    if (!cloudConfigured()) return Promise.resolve();
    if (cloudConnectRef.current) return cloudConnectRef.current;
    const connecting = (async () => {
      setCloudState("connecting");
      try {
        // With a Google token, sign in fresh; without one, fall back to
        // the Firebase session persisted from a previous visit — Firebase
        // keeps its own long-lived refresh token, so cloud sync shouldn't
        // die just because the ~1h Gmail token did (it used to: saves went
        // silently local-only every time the app was reopened after an
        // hour away).
        const session = token ? await cloudSignIn(token) : await cloudRestore();
        if (!session) {
          // No token AND nothing persisted — genuinely signed out.
          cloudConnectRef.current = null; // a later sign-in retries
          setCloudState("off");
          return;
        }
        setCloudEmail(session.email);
        const remote = await cloudGet();
        const local = dataRef.current || {};
        if (remote?.json) {
          // Per-order merge (see lib/syncMerge.js), NOT "newest blob wins" —
          // a stale device's save could otherwise clobber a fresher edit
          // made on another device to a completely different order (e.g. a
          // "Try real prices" fix vanishing after refresh because some
          // unrelated save on another device raced it with a newer top-
          // level timestamp). Each order carries its own updatedAt, so the
          // merge keeps whichever copy of EACH order is actually newer and
          // takes the union of both order lists — nothing is lost.
          const parsed = JSON.parse(remote.json);
          const merged = mergeState(local, parsed);
          dataRef.current = merged; // before setData: await-ers read the merged state immediately
          setData(merged);
          storage.set(STORAGE_KEY, JSON.stringify(merged)).catch(() => {});
          if (remoteIsStale(merged.orders, parsed.orders) || remoteRatingsStale(merged.ratings, parsed.ratings) || remoteUnmatchedStale(merged.unmatchedStatus, parsed.unmatchedStatus)) {
            // Remote was missing something local had, or had an older copy
            // of some order/rating, or carried unmatched-status rows the
            // merge added/self-cleaned — push the merged truth back so both
            // sides converge instead of staying split.
            await cloudSet(JSON.stringify(merged), merged.updatedAt).catch(() => {});
          }
          pushLog(`Cloud: merged with Firebase (${merged.orders.length} order(s) total).`, "ok");
        } else if (local.orders?.length || local.updatedAt) {
          await cloudSet(JSON.stringify(local), local.updatedAt || Date.now());
          pushLog("Cloud: uploaded local data to Firebase.", "ok");
        }
        cloudUnsubRef.current = await cloudSubscribe((val) => {
          if (!val?.json) return;
          if (syncingRef.current) {
            // A sync is writing from its own snapshot — hold the payload
            // and replay it when the sync ends (pendingRemoteRef effect
            // below) instead of merging mid-sync, which would race the
            // sync loop's own saves.
            pendingRemoteRef.current = val;
            pushLog("Cloud: remote change arrived mid-sync — holding it to merge after the sync.", "warn");
            return;
          }
          applyRemote(val, "Cloud: merged updates from another device.");
        });
        // Live carrier ETAs (written by the scheduled GitHub Action) — read-only.
        try {
          cloudCarrierUnsubRef.current = await cloudSubscribeCarrier(setCarrier);
        } catch { /* carrier data optional */ }
        // Clock sanity check: the per-order merge trusts each device's own
        // Date.now() stamps, so a skewed clock silently out-ranks newer
        // edits from correctly-clocked devices. Detect and warn.
        try {
          const skew = await cloudClockSkew();
          if (Math.abs(skew) > 2 * 60e3) {
            pushLog(`⚠ This device's clock is ~${Math.round(Math.abs(skew) / 60e3)} min ${skew > 0 ? "ahead of" : "behind"} real time — cross-device edits may merge in the wrong order. Fix this device's system clock.`, "warn");
          }
        } catch { /* best-effort */ }
        cloudReadyRef.current = true;
        setCloudState("on");
        // Connect just merged with the cloud and (if local had anything
        // newer) pushed the merged truth back — nothing is pending anymore.
        setCloudDirty(false);
      } catch (e) {
        cloudConnectRef.current = null; // allow retry on next token
        setCloudState("error");
        pushLog("Cloud sync failed: " + e.message + " — data stays local. Check the Firebase setup in README.", "warn");
      }
    })();
    cloudConnectRef.current = connecting;
    return connecting;
  }, [applyRemote]);

  /* Replay the remote update (if any) that arrived while a sync was
     running — the live listener parks it in pendingRemoteRef rather than
     merging mid-sync. */
  useEffect(() => {
    if (syncing || !pendingRemoteRef.current) return;
    const val = pendingRemoteRef.current;
    pendingRemoteRef.current = null;
    applyRemote(val, "Cloud: merged the update that arrived mid-sync.");
  }, [syncing, applyRemote]);

  /* On open: refresh the Google token silently if possible (no popup —
     works whenever the browser's Google session is alive and consent was
     granted before), then connect cloud. connectCloud(null) still restores
     the persisted Firebase session, so an expired Gmail token no longer
     silently disables cloud sync until the next manual sign-in. */
  useEffect(() => {
    if (!loaded) return;
    (async () => {
      let token = getStoredToken();
      if (!token && hasConsented()) {
        try {
          token = await signIn({ silent: true });
          pushLog("Google session refreshed silently.", "ok");
        } catch { /* blocked or session gone — cloud still restores below */ }
      }
      setGoogleSignedIn(isSignedIn());
      connectCloud(token);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  /* Keep the signed-in indicator honest and the token fresh. The Gmail
     token dies after ~1h and nothing used to notice — the sidebar dot
     stayed green and the next action just popped a consent screen. Every
     minute: reflect the real state; when expired, attempt one silent
     refresh per 10 minutes (no UI, fails quietly). */
  useEffect(() => {
    let lastSilent = 0;
    const id = setInterval(async () => {
      if (!isSignedIn() && hasConsented() && Date.now() - lastSilent > 10 * 60e3) {
        lastSilent = Date.now();
        try { await signIn({ silent: true }); } catch { /* needs interaction */ }
      }
      setGoogleSignedIn(isSignedIn());
    }, 60e3);
    return () => clearInterval(id);
  }, []);

  /* Carrier truth → order status. When the tracking worker reports a
     package Delivered but the order still says "shipped" (Temu's delivered
     email not synced yet, or matched wrong in an old sync), promote the
     order automatically instead of waiting for an email pass. Idempotent:
     once promoted, the filter matches nothing. */
  useEffect(() => {
    if (!loaded || syncing) return;
    const cur = dataRef.current || data;
    const done = cur.orders.filter(
      (o) => (o.status || "ordered") === "shipped" && o.tracking?.number && carrier[o.tracking.number]?.status === "Delivered"
    );
    if (!done.length) return;
    const ids = new Set(done.map((o) => o.id));
    save({ ...cur, orders: cur.orders.map((o) => (ids.has(o.id) ? { ...o, status: "delivered", updatedAt: Date.now() } : o)) });
    pushLog(`Carrier reported delivered — updated ${done.length} order(s): ${done.map((o) => o.id).join(", ")}`, "ok");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carrier, loaded, syncing, data.orders]);

  /* ----- settings: API key ----- */
  const saveApiKey = useCallback((key) => {
    setApiKey(key);
    setApiKeyInput(key);
  }, []);

  /* ----- settings: Google sign-in ----- */
  const handleGoogleSignIn = useCallback(async () => {
    try {
      const token = await signIn({ interactive: true });
      setGoogleSignedIn(true);
      pushLog("Signed in to Google.", "ok");
      // A previous connect may exist in a broken state (e.g. cloudSet
      // failures flipped cloudState to "error" while the settled connect
      // promise is still cached) — tear it down so connectCloud rebuilds
      // cleanly instead of returning the stale promise and doing nothing.
      if (cloudUnsubRef.current) { try { cloudUnsubRef.current(); } catch { /* noop */ } cloudUnsubRef.current = null; }
      if (cloudCarrierUnsubRef.current) { try { cloudCarrierUnsubRef.current(); } catch { /* noop */ } cloudCarrierUnsubRef.current = null; }
      cloudReadyRef.current = false;
      cloudConnectRef.current = null;
      connectCloud(token);
    } catch (e) {
      pushLog("Google sign-in failed: " + e.message, "error");
    }
  }, [connectCloud]);

  const handleGoogleSignOut = useCallback(() => {
    signOut();
    setGoogleSignedIn(false);
    if (cloudUnsubRef.current) { try { cloudUnsubRef.current(); } catch { /* noop */ } cloudUnsubRef.current = null; }
    if (cloudCarrierUnsubRef.current) { try { cloudCarrierUnsubRef.current(); } catch { /* noop */ } cloudCarrierUnsubRef.current = null; }
    setCarrier({});
    cloudReadyRef.current = false;
    cloudConnectRef.current = null;
    cloudSignOut();
    if (cloudConfigured()) setCloudState("off");
    setCloudEmail(null);
    setDirectory(null);
    setAdminViewUid(null);
    setAdminViewState(null);
    pushLog("Signed out of Google.");
  }, []);

  /* ----- push notifications (see lib/firebase.js push section) ----- */

  /* One-time capability probe: is web push even possible in this browser?
     (False on iOS Safari in a plain tab — Notification doesn't exist until
     the PWA is installed to the home screen — and when unconfigured.) */
  useEffect(() => {
    if (!pushConfigured()) { setPushSupport(false); return; }
    let alive = true;
    pushSupported().then((ok) => { if (alive) setPushSupport(ok); }).catch(() => { if (alive) setPushSupport(false); });
    return () => { alive = false; };
  }, []);

  /* Foreground messages (tab open and focused) bypass the SW notification
     path — log them to the sync log instead. Idempotent via ref. */
  const ensurePushForegroundLog = useCallback(async () => {
    if (pushFgUnsubRef.current) return;
    try {
      pushFgUnsubRef.current = await pushOnForeground((payload) => {
        const d = payload?.data || {};
        pushLog(`🔔 ${d.title || "Push notification"}${d.body ? " — " + d.body : ""}`, "info");
      });
    } catch { /* foreground logging is a nicety, never worth failing over */ }
  }, []);

  /* On each cloud connect, re-validate this device's token if push was
     enabled here: FCM tokens rotate, and updatedAt tells the sending Action
     which devices are still alive. pushRefresh() also self-heals the toggle
     when browser permission was revoked since (returns null → flip off). */
  useEffect(() => {
    if (cloudState !== "on" || !pushConfigured() || !pushLocallyEnabled()) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await pushRefresh();
        if (cancelled) return;
        if (token) {
          setPushEnabled(true);
          ensurePushForegroundLog();
        } else if (!pushLocallyEnabled()) {
          setPushEnabled(false);
          pushLog("Push notifications were turned off — browser permission is no longer granted.", "warn");
        }
      } catch (e) {
        pushLog("Push token refresh failed: " + e.message, "warn");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudState]);

  const togglePush = useCallback(async () => {
    setPushBusy(true);
    try {
      if (pushLocallyEnabled()) {
        await pushDisable();
        setPushEnabled(false);
        pushLog("Push notifications disabled on this device.", "ok");
      } else {
        await pushEnable();
        setPushEnabled(true);
        ensurePushForegroundLog();
        pushLog("Push notifications enabled on this device.", "ok");
      }
    } catch (e) {
      setPushEnabled(pushLocallyEnabled());
      pushLog("Push notifications: " + e.message, "error");
    } finally {
      setPushBusy(false);
    }
  }, [ensurePushForegroundLog]);

  /* iOS Safari pre-install: Notification doesn't exist in a normal tab, but
     DOES once the PWA runs standalone from the home screen (iOS 16.4+) —
     used by SettingsPanel to show "install first" instead of a dead toggle. */
  const pushNeedsInstall =
    typeof Notification === "undefined" &&
    !(window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone === true);

  /* ----- admin: directory + read-only "view as user" ----- */
  const isAdmin = !!(ADMIN_EMAIL && cloudEmail && cloudEmail === ADMIN_EMAIL);

  const loadDirectory = useCallback(async () => {
    setDirectoryError(null);
    try {
      setDirectory(await cloudListDirectory());
    } catch (e) {
      setDirectoryError(e.message);
    }
  }, []);

  const viewUserData = useCallback(async (otherUid) => {
    setAdminViewUid(otherUid);
    setAdminViewState(null);
    setAdminViewLoading(true);
    try {
      const remote = await cloudGetUserState(otherUid);
      setAdminViewState(remote?.json ? JSON.parse(remote.json) : { orders: [] });
    } catch (e) {
      pushLog(`Admin view failed for ${otherUid}: ${e.message}`, "error");
      setAdminViewUid(null);
    } finally {
      setAdminViewLoading(false);
    }
  }, []);

  const exitAdminView = useCallback(() => {
    setAdminViewUid(null);
    setAdminViewState(null);
  }, []);

  /* ----- export / import ----- */
  const stamp = () => new Date().toISOString().slice(0, 10);

  const exportData = useCallback(() => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `temu-manifest-${stamp()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data]);

  const exportItemsCsv = useCallback(
    () => downloadCsv(`temu-items-${stamp()}.csv`, itemsCsv(data.orders)),
    [data.orders]
  );
  const exportOrdersCsv = useCallback(
    () => downloadCsv(`temu-orders-${stamp()}.csv`, ordersCsv(data.orders)),
    [data.orders]
  );

  const importData = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.orders)) {
          throw new Error("that file doesn't look like a Temu Manifest backup (no orders array)");
        }
        await save({
          orders: parsed.orders || [],
          processedIds: parsed.processedIds || [],
          lastSync: parsed.lastSync || null,
          autoSync: parsed.autoSync ?? true,
          ratings: parsed.ratings || {},
          unmatchedStatus: parsed.unmatchedStatus || [], // pre-persistence backups simply lack the key
        });
        pushLog(`Imported ${parsed.orders?.length || 0} order(s).`, "ok");
      } catch (e) {
        pushLog("Import failed: " + e.message, "error");
      }
    };
    reader.readAsText(file);
  }, [save]);

  /* ----- manual edit (desktop full-order form) ----- */
  const startEdit = useCallback((order) => {
    setEditingId(order.id);
    setEditDraft(JSON.parse(JSON.stringify(order)));
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditDraft(null);
  }, []);

  const saveEdit = useCallback(() => {
    if (!editDraft) return;
    if (syncing) { pushLog("Can't save edits while a sync is running — wait for it to finish.", "warn"); return; }
    const items = (editDraft.items || []).map((it) => {
      const listed = numOrNull(it.listed);
      const paid = numOrNull(it.paid);
      return {
        ...it,
        qty: Math.max(1, Number(it.qty) || 1),
        listed,
        paid,
        discountPct: listed > 0 && paid != null ? 1 - paid / listed : null,
        estimated: false, // hand-reviewed, no longer just an estimate
      };
    });
    const itemSum = items.reduce((s, it) => s + (it.listed || 0) * (it.qty || 1), 0);
    const paidSum = items.reduce((s, it) => s + (it.paid || 0) * (it.qty || 1), 0);
    const cleaned = {
      ...editDraft,
      subtotal: numOrNull(editDraft.subtotal),
      discount: numOrNull(editDraft.discount),
      shipping: numOrNull(editDraft.shipping),
      tax: numOrNull(editDraft.tax),
      total: numOrNull(editDraft.total),
      items,
      discountFactor: itemSum > 0 ? paidSum / itemSum : null,
      manualEdit: true,
      updatedAt: Date.now(), // per-order timestamp for cloud merge (lib/syncMerge.js)
    };
    const cur = dataRef.current || data; // dataRef, not the render closure — see save()
    save({ ...cur, orders: cur.orders.map((o) => (o.id === cleaned.id ? cleaned : o)) });
    pushLog(`Saved manual edits to ${cleaned.id}.`, "ok");
    setEditingId(null);
    setEditDraft(null);
  }, [editDraft, data, save, syncing]);

  /* ----- quick single-item edit (mobile detail sheet) ----- */
  const updateItem = useCallback((orderId, itemIdx, patch) => {
    if (syncing) { pushLog("Can't save edits while a sync is running.", "warn"); return; }
    const cur = dataRef.current || data; // dataRef, not the render closure — see save()
    const orders = cur.orders.map((o) => {
      if (o.id !== orderId) return o;
      const items = (o.items || []).map((it, i) => {
        if (i !== itemIdx) return it;
        const listed = numOrNull(patch.listed);
        const paid = numOrNull(patch.paid);
        return {
          ...it,
          name: patch.name ?? it.name,
          category: CATEGORIES.includes(patch.category) ? patch.category : it.category,
          qty: Math.max(1, Number(patch.qty) || 1),
          listed,
          paid,
          discountPct: listed > 0 && paid != null ? 1 - paid / listed : null,
          estimated: false, // hand-reviewed
        };
      });
      return { ...o, items, manualEdit: true, updatedAt: Date.now() }; // per-order timestamp for cloud merge
    });
    save({ ...cur, orders });
    pushLog(`Saved item edit in ${orderId}.`, "ok");
  }, [data, save, syncing]);

  /* ----- item ratings ("Rate items" tab) -----
     Unlike updateItem, these mutate a SIBLING top-level key (data.ratings)
     rather than anything inside cur.orders — no order object is touched,
     so there's no order-level updatedAt to stamp and no manualEdit flag to
     set (see lib/syncMerge.js's "Ratings merge" header for why ratings
     merge independently of orders). Clearing a thumb writes verdict:null
     rather than deleting the map key — see lib/derive.js's ratingQueues
     header for why the key must never be removed. */
  const rateItem = useCallback((orderId, itemIdx, verdict) => {
    if (syncing) { pushLog("Can't rate items while a sync is running.", "warn"); return; }
    const cur = dataRef.current || data; // dataRef, not the render closure — see save()
    const key = analyticsItemKey({ orderId, itemIdx });
    const existing = cur.ratings?.[key];
    // Tap the active thumb again → clears; tap the opposite thumb → switches
    // directly to the new verdict in one tap.
    const nextVerdict = existing?.verdict === verdict ? null : verdict;
    const nextRating = {
      verdict: nextVerdict,
      // Buy-again requires a "liked" verdict — switching away from "up"
      // (or clearing it) auto-clears buyAgain in the same write so section
      // 3 never silently retains a stale entry.
      buyAgain: nextVerdict === "up" ? !!existing?.buyAgain : false,
      ratedAt: Date.now(),
    };
    save({ ...cur, ratings: { ...(cur.ratings || {}), [key]: nextRating } });
  }, [data, save, syncing]);

  const toggleBuyAgain = useCallback((orderId, itemIdx) => {
    if (syncing) { pushLog("Can't rate items while a sync is running.", "warn"); return; }
    const cur = dataRef.current || data; // dataRef, not the render closure — see save()
    const key = analyticsItemKey({ orderId, itemIdx });
    const existing = cur.ratings?.[key];
    if (existing?.verdict !== "up") return; // buy-again gated on "liked" — see rateItem above
    save({ ...cur, ratings: { ...(cur.ratings || {}), [key]: { ...existing, buyAgain: !existing.buyAgain, ratedAt: Date.now() } } });
  }, [data, save, syncing]);

  const deleteOrder = useCallback((id) => {
    if (syncing) return;
    const cur = dataRef.current || data; // dataRef, not the render closure — see save()
    save({ ...cur, orders: cur.orders.filter((x) => x.id !== id) });
  }, [data, save, syncing]);

  /* ----- open this order's detail page on temu.com in a new tab -----
     Orders synced after the link feature shipped have `orderUrl` stored.
     Older orders fetch their email on demand, extract the link, and cache
     it. The blank tab is opened synchronously (before any await) so popup
     blockers treat it as user-initiated; if no Temu link can be found, the
     tab falls back to a Gmail search for the PO number. */
  const openOrderPage = useCallback(async (order) => {
    const win = window.open("about:blank", "_blank");
    const nav = (url) => { if (win) win.location = url; else window.open(url, "_blank"); };
    // Use the stored link only if it matches the real order-button signature
    // (_order_ticket / cmsg_transit). Links cached by the older extractor
    // could be the email's change-address link — treat those as stale and
    // re-extract from the email, which self-heals the stored value.
    if (order.orderUrl && isOrderDetailLink(order.orderUrl)) { nav(order.orderUrl); return; }
    try {
      if (order.messageId && isSignedIn()) {
        const token = await getToken({ interactive: false });
        const fullMsg = await getMessageFull(order.messageId, token);
        const html = extractHtml(fullMsg.payload);
        const link = extractOrderLink(html, order.id);
        if (link) {
          const cur = dataRef.current || data; // dataRef, not the render closure — see save()
          save({ ...cur, orders: cur.orders.map((o) => (o.id === order.id ? { ...o, orderUrl: link } : o)) });
          nav(link);
          return;
        }
      }
    } catch { /* fall through */ }
    if (order.orderUrl) { nav(order.orderUrl); return; } // better than nothing
    nav(`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(order.id.startsWith("PO-") ? order.id : "from:temu.com " + order.id)}`);
  }, [data, save]);

  /* ----- diagnostics: isolate API vs Gmail auth problems ----- */
  const testConnection = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setLog([]);
    try {
      pushLog("Test 1/2: plain Anthropic API call…");
      const t0 = Date.now();
      const r1 = await callClaude(`Reply with exactly: OK`, { timeoutMs: 45000 });
      pushLog(`✓ API reachable in ${((Date.now() - t0) / 1000).toFixed(1)}s — "${textOf(r1).slice(0, 30)}"`, "ok");
    } catch (e) {
      pushLog("✗ Anthropic API call failed: " + e.message, "error");
      pushLog("→ Check your API key in Settings.", "warn");
      setSyncing(false);
      return;
    }
    try {
      pushLog("Test 2/2: Gmail search (1 tiny query)…");
      const t0 = Date.now();
      const token = await getToken({ interactive: true });
      setGoogleSignedIn(true);
      connectCloud(token);
      const msgs = await searchMessages(`from:transaction.temu.com subject:"order confirmation"`, token, 1);
      let subject = null;
      if (msgs.length) {
        const meta = await getMessageMetadata(msgs[0].id, token);
        subject = headerValue(meta, "Subject");
      }
      pushLog(`✓ Gmail reachable in ${((Date.now() - t0) / 1000).toFixed(1)}s — found: ${msgs.length > 0}${subject ? ` ("${subject.slice(0, 40)}…")` : ""}`, "ok");
      pushLog("Both tests passed — hit Check Gmail again.", "ok");
    } catch (e) {
      pushLog("✗ Gmail call failed: " + e.message, "error");
      pushLog("→ Check the Google Cloud OAuth setup in README.md, and that this origin is an authorized JavaScript origin.", "warn");
    } finally {
      setSyncing(false);
    }
  }, [syncing, connectCloud]);

  /* ----- process a single order-confirmation email -----
     Shared by sync() and retryFailedEmails() so a failed read (network
     hiccup, timeout, occasional bad vision response) can be re-attempted
     later without re-running the whole sync. On success, mutates `working`
     in place (pushes/updates the order + marks the email processed) and
     clears the email from the failed list; on failure, leaves `working`
     untouched and records it in the failed list for a later retry. */
  const processOrderEmail = useCallback(async (em, token, working, opts = {}) => {
    // forceId: re-parse this specific order even if it already exists with
    // items and/or has manual edits (used by the per-order "Re-read from
    // email" action to restore deleted items).
    const { forceId = null } = opts;
    const saveOrder = (order) => {
      const dupIdx = working.orders.findIndex((o) => o.id === order.id);
      if (dupIdx >= 0) {
        const old = working.orders[dupIdx];
        // Hand-edited orders are never silently overwritten by a re-read —
        // only an explicit force (Re-read button) replaces them.
        if (old.manualEdit && old.id !== forceId && old.items?.length) return;
        // Keep status/eta/link learned from later status emails — a re-read
        // of the confirmation email shouldn't clobber them.
        working.orders[dupIdx] = { ...order, status: old.status, eta: order.eta || old.eta, orderUrl: order.orderUrl || old.orderUrl };
      } else working.orders.push(order);
    };
    try {
      /* Each Temu order email marks the sections that matter with HTML
         comments: goods_list (item rows rendered as one PNG) and
         order_pay_info_row (payment summary). Everything else is marketing.
         Some emails bundle several orders into ONE message ("Your Temu
         orders confirmation..." — plural subject, no PO number in it). Each
         sub-order there gets its own goods_list image, but there's only one
         combined payment summary for the whole message. */
      const fullMsg = await getMessageFull(em.id, token);
      const html = extractHtml(fullMsg.payload);
      const subOrders = extractSubOrders(html);

      if (subOrders.length > 1) {
        // Split-order email. Each sub-order has its own pre-computed
        // "Order total" (plain text) — there's no per-sub-order
        // subtotal/shipping/tax breakdown available (only a combined one for
        // the whole message), so passing `total` with shipping/tax at 0
        // makes applyDiscounts treat it as the net amount paid for that
        // sub-order's items, same as the "order.discount" fallback path.
        const goodsSections = extractAllSections(html, "goods_list");
        if (!goodsSections.length) throw new Error("no goods_list images found in split-order email");
        if (goodsSections.length !== subOrders.length) {
          pushLog(`Split-order email has ${subOrders.length} orders but ${goodsSections.length} item image(s) — matching by position, some may be off.`, "warn");
        }
        let readCount = 0;
        for (let i = 0; i < subOrders.length; i++) {
          const sub = subOrders[i];
          // Per-sub-order gating: one split email yields several orders. If
          // this sub-order is already stored with items (and isn't the one
          // being force-re-read), skip it — no vision call. This is what
          // lets Reconcile restore a DELETED sub-order without re-reading
          // (or paying for) its still-present siblings.
          const existing = working.orders.find((o) => o.id === sub.orderId);
          const isForced = forceId && sub.orderId === forceId;
          if (existing && existing.items?.length && !isForced) continue;
          const goods = extractImgSrcs(goodsSections[i] || "").filter((u) => /^https?:\/\//.test(u));
          if (!goods.length) {
            pushLog(`${sub.orderId}: no item image found, skipping.`, "warn");
            continue;
          }
          readCount++;
          const parsed = extractJSON(await callClaude([
            ...goods.map((u) => ({ type: "image", source: { type: "url", url: u } })),
            {
              type: "text",
              text:
                `This image shows the purchased items of one Temu order (one of several bundled into this email) — one row per item: product photo, name, and quantity. ` +
                `Temu's split-order emails often do NOT show a price per item (only the order's final total is known separately, from elsewhere) — if you don't see a dollar amount on a row, set "listed" to null rather than guessing or estimating one. ` +
                `Respond with ONLY compact single-line JSON, no prose: {"items":[{"n":"short name max 8 words","listed":null,"qty":1,"c":"cat","gi":0,"y":50}]}. ` +
                `"gi" = 0-based index of which image the row is in (0 if only one image); "y" = vertical center of that item's row within its image, as an integer percent (0=top, 100=bottom). ` +
                `"c" must be one of: ${CATEGORIES.join(", ")}.`,
            },
          ]));
          const order = applyDiscounts({
            id: sub.orderId,
            messageId: em.id,
            date: em.date,
            orderUrl: extractOrderLink(html, sub.orderId),
            eta: extractEta(html),
            subtotal: null, discount: null, shipping: 0, tax: 0, total: sub.total,
            status: "ordered",
            updatedAt: Date.now(), // per-order timestamp for cloud merge
            items: (parsed.items || []).map((it) => ({
              name: it.n, listed: it.listed, qty: it.qty || 1,
              category: CATEGORIES.includes(it.c) ? it.c : "Other",
              thumbUrl: goods[it.gi || 0] || goods[0] || null,
              thumbY: Number.isFinite(it.y) ? Math.max(0, Math.min(100, it.y)) : null,
            })),
            images: goods,
          });
          saveOrder(order);
          pushLog(`✓ ${order.id} (${i + 1}/${subOrders.length} in split email): ${order.items.length} items, ${fmt(order.total)}`, "ok");
        }
        if (readCount === 0) pushLog(`Split email checked — all ${subOrders.length} sub-orders already present.`);
      } else {
        // Normal single-order email — one goods_list image and one
        // order_pay_info_row image with the full payment breakdown.
        //
        // Diagnostic: if this email has MULTIPLE goods_list sections but we
        // couldn't read sub-order IDs out of it, it's a split email in a
        // format extractSubOrders doesn't recognize — parsing it as a single
        // order silently loses the other sub-orders (whose status emails
        // then never match). Shout about it so it's debuggable.
        const goodsSectionCount = extractAllSections(html, "goods_list").length;
        if (goodsSectionCount > 1) {
          pushLog(`⚠ Email ${em.id.slice(0, 10)}… has ${goodsSectionCount} item images but no readable sub-order IDs — split-email format not recognized; only the first order will be captured. Download the log and report this.`, "error");
        }
        const goods = extractImgSrcs(extractSection(html, "goods_list")).filter((u) => /^https?:\/\//.test(u));
        const pay = extractImgSrcs(extractSection(html, "order_pay_info_row")).filter((u) => /^https?:\/\//.test(u));
        if (!goods.length) throw new Error("goods_list image not found in email HTML");

        const urls = [...goods, ...pay];
        // Orders can run to 15-20+ items — the default 2000-token budget
        // (anthropic.js) can truncate the JSON mid-response for a big one.
        const parsed = extractJSON(await callClaude([
          ...urls.map((u) => ({ type: "image", source: { type: "url", url: u } })),
          {
            type: "text",
            text:
              `The first ${goods.length} image(s) show the purchased items of a Temu order — one row per item: product photo on the left, then name, quantity, price. ` +
              `The remaining ${pay.length} image(s) show the payment summary. ` +
              `Respond with ONLY compact single-line JSON, no prose: ` +
              `{"subtotal":0,"discount":0,"shipping":0,"tax":0,"total":0,` +
              `"items":[{"n":"short name max 8 words","listed":0,"qty":1,"c":"cat","gi":0,"y":50}]}. ` +
              `"discount" = sum of all discount/coupon/credit lines as a positive number; "total" = amount actually charged; use null for anything not visible. ` +
              `"gi" = 0-based index of which items image the row is in; "y" = vertical center of that item's row within its image, as an integer percent (0=top, 100=bottom). ` +
              `"c" must be one of: ${CATEGORIES.join(", ")}.`,
          },
        ], { maxTokens: 4000 }));

        const po = em.orderId || extractPoNumber(html) || em.id;
        const order = applyDiscounts({
          id: po,
          messageId: em.id,
          date: em.date,
          orderUrl: extractOrderLink(html, po),
          eta: extractEta(html),
          subtotal: parsed.subtotal, discount: parsed.discount,
          shipping: parsed.shipping, tax: parsed.tax, total: parsed.total,
          status: "ordered",
          updatedAt: Date.now(), // per-order timestamp for cloud merge
          items: (parsed.items || []).map((it) => ({
            name: it.n, listed: it.listed, qty: it.qty || 1,
            category: CATEGORIES.includes(it.c) ? it.c : "Other",
            thumbUrl: goods[it.gi || 0] || goods[0] || null,
            thumbY: Number.isFinite(it.y) ? Math.max(0, Math.min(100, it.y)) : null,
          })),
          images: urls,
        });
        saveOrder(order);
        pushLog(`✓ ${order.id}: ${order.items.length} items, ${fmt(order.total)}`, "ok");
      }

      if (!working.processedIds.includes(em.id)) working.processedIds.push(em.id);
      setFailedEmails((f) => f.filter((x) => x.id !== em.id));
      return true;
    } catch (e) {
      pushLog(`Order email failed (${em.id.slice(0, 10)}…): ${e.message}`, "error");
      setFailedEmails((f) => (f.some((x) => x.id === em.id) ? f : [...f, em]));
      return false;
    }
  }, []);

  /* ----- re-read ONE order from its source email -----
     For when an order's data is wrong or items were deleted by hand:
     re-runs the vision parse for just this order (forceId overrides the
     manual-edit protection) and keeps its status/eta/link. */
  const rereadOrder = useCallback(async (order) => {
    if (syncing) return;
    if (!order.messageId) {
      pushLog(`${order.id} has no source email recorded — try Reconcile with Gmail instead.`, "warn");
      return;
    }
    setSyncing(true);
    cancelRequestedRef.current = false;
    try {
      const token = await getToken({ interactive: true });
      setGoogleSignedIn(true);
      const base = dataRef.current || data; // dataRef, not the render closure — see save()
      const working = { ...base, orders: [...base.orders], processedIds: [...base.processedIds] };
      pushLog(`Re-reading ${order.id} from its email…`);
      const em = {
        id: order.messageId,
        kind: "order",
        orderId: /^PO-/.test(order.id) ? order.id : null,
        date: order.date,
      };
      // Re-read replaces this order's items[] wholesale from a fresh vision
      // parse — capture before/after so any ratings on this order can be
      // carried forward by name match instead of silently orphaned (see
      // lib/derive.js's remapRatingsAfterReplace and CLAUDE.md's survival
      // matrix).
      const oldItems = working.orders.find((o) => o.id === order.id)?.items || [];
      await processOrderEmail(em, token, working, { forceId: order.id });
      const newItems = working.orders.find((o) => o.id === order.id)?.items || [];
      working.ratings = remapRatingsAfterReplace(working.ratings, order.id, oldItems, newItems);
      await save({ ...working });
      pushLog("Re-read complete.", "ok");
    } catch (e) {
      pushLog("Re-read failed: " + e.message, "error");
    } finally {
      setSyncing(false);
    }
  }, [syncing, data, save, processOrderEmail]);

  /* ----- find & import ONE missing order by PO number -----
     For unmatched status emails: their order was never created (usually a
     split-email sub-order the parser missed). This searches Gmail for the
     confirmation email containing that PO and force-parses it. */
  const importMissingOrder = useCallback(async (po) => {
    if (syncing || !po) return;
    setSyncing(true);
    cancelRequestedRef.current = false;
    try {
      const token = await getToken({ interactive: true });
      setGoogleSignedIn(true);
      pushLog(`Searching Gmail for ${po}'s order confirmation…`);
      const msgs = await searchMessages(`from:transaction.temu.com "${po}"`, token, 10);
      let found = null;
      for (const m of msgs) {
        const meta = await getMessageMetadata(m.id, token);
        const subject = headerValue(meta, "Subject");
        if (/orders? confirmation/i.test(subject)) {
          found = {
            id: m.id,
            kind: "order",
            orderId: extractPoNumber(subject),
            date: headerValue(meta, "Date") ? new Date(headerValue(meta, "Date")).toISOString().slice(0, 10) : null,
          };
          break;
        }
      }
      if (!found) {
        pushLog(`No order-confirmation email containing ${po} was found (checked ${msgs.length} matches). Open Gmail and search "${po}" to see what exists.`, "warn");
        return;
      }
      const base = dataRef.current || data; // dataRef, not the render closure — see save()
      const working = { ...base, orders: [...base.orders], processedIds: [...base.processedIds], unmatchedStatus: [...(base.unmatchedStatus || [])] };
      await processOrderEmail(found, token, working, { forceId: po });
      if (working.orders.some((o) => o.id === po)) {
        // Drop this PO's Review-queue rows BEFORE saving, so the removal
        // persists (and syncs) atomically with the imported order instead of
        // flickering back on the next cloud merge. The merge can't resurrect
        // them anyway — the order now exists, which self-cleans its rows in
        // mergeUnmatchedStatus (lib/syncMerge.js) — this just keeps the local
        // UI consistent in the same paint.
        working.unmatchedStatus = working.unmatchedStatus.filter((x) => x.oid !== po);
        await save({ ...working });
        pushLog(`✓ ${po} imported — run Reconcile to re-apply its status emails.`, "ok");
      } else {
        await save({ ...working });
        pushLog(`Read ${po}'s email but the order still didn't materialize — the split-email format likely isn't recognized. Download the log and report this email.`, "error");
      }
    } catch (e) {
      pushLog("Import failed: " + e.message, "error");
    } finally {
      setSyncing(false);
    }
  }, [syncing, data, save, processOrderEmail]);

  /* ----- fix estimated prices using a status email's priced receipt -----
     Split-order confirmation emails often can't show a per-item price (Temu
     only gives the combined order total for the whole message), so those
     items get an even-split estimate (see the fallback branch of
     applyDiscounts). But EVERY later status email for that PO — shipped,
     out-for-delivery, delivered — embeds the SAME goods_list + payment-
     summary image pair as a normal single-order confirmation, and THAT copy
     has real per-item prices. This finds one such email, re-runs the normal
     (non-split) vision parse against its images, and replaces the order's
     estimated items with the real numbers. Manual only (costs one vision
     call) — triggered from the Review queue's "Estimated prices" list, either
     one order at a time or all at once (see fixAllEstimatedPrices below). The
     result is marked manualEdit so a later re-read of the (still priceless)
     split confirmation can't silently revert it back to an estimate.

     fetchFixedOrder is the shared core — it takes an order OBJECT (not an
     id looked up from React state) so the bulk loop below can thread its own
     in-progress working copy through repeated calls without racing React's
     async state updates. It doesn't touch data/save/syncing itself; callers
     own that. */
  const fetchFixedOrder = useCallback(async (order, token) => {
    const msgs = await searchMessages(
      `from:transaction.temu.com subject:(shipped OR delivered OR arrived OR "transferred to" OR delivery) "${order.id}"`,
      token, 10
    );
    let html = null;
    for (const m of msgs) {
      try {
        const fullMsg = await getMessageFull(m.id, token);
        const h = extractHtml(fullMsg.payload);
        if (extractSection(h, "goods_list") && extractSection(h, "order_pay_info_row")) { html = h; break; }
      } catch { /* try next candidate */ }
    }
    if (!html) return { error: "no-status-email" };
    const goods = extractImgSrcs(extractSection(html, "goods_list")).filter((u) => /^https?:\/\//.test(u));
    const pay = extractImgSrcs(extractSection(html, "order_pay_info_row")).filter((u) => /^https?:\/\//.test(u));
    if (!goods.length) return { error: "no-item-image" };
    const urls = [...goods, ...pay];
    // Orders re-consolidated from a split-purchase sub-order can run to
    // 15-20+ items — the default 2000-token budget (see anthropic.js)
    // truncated the JSON mid-response for a real case like this. Full
    // item + price + category JSON for a big order needs more headroom.
    const resp = await callClaude([
      ...urls.map((u) => ({ type: "image", source: { type: "url", url: u } })),
      {
        type: "text",
        text:
          `The first ${goods.length} image(s) show the purchased items of a Temu order — one row per item: product photo on the left, then name, quantity, price. ` +
          `The remaining ${pay.length} image(s) show the payment summary. ` +
          `Respond with ONLY compact single-line JSON, no prose: ` +
          `{"subtotal":0,"discount":0,"shipping":0,"tax":0,"total":0,` +
          `"items":[{"n":"short name max 8 words","listed":0,"qty":1,"c":"cat","gi":0,"y":50}]}. ` +
          `"discount" = sum of all discount/coupon/credit lines as a positive number; "total" = amount actually charged; use null for anything not visible. ` +
          `"gi" = 0-based index of which items image the row is in; "y" = vertical center of that item's row within its image, as an integer percent (0=top, 100=bottom). ` +
          `"c" must be one of: ${CATEGORIES.join(", ")}.`,
      },
    ], { maxTokens: 4000 });
    recordUsage("fixPrices", resp.usage);
    const parsed = extractJSON(resp);
    const fixed = applyDiscounts({
      ...order,
      subtotal: parsed.subtotal ?? order.subtotal,
      discount: parsed.discount ?? order.discount,
      shipping: parsed.shipping ?? order.shipping,
      tax: parsed.tax ?? order.tax,
      total: parsed.total ?? order.total,
      items: (parsed.items || []).map((it) => ({
        name: it.n, listed: it.listed, qty: it.qty || 1,
        category: CATEGORIES.includes(it.c) ? it.c : "Other",
        thumbUrl: goods[it.gi || 0] || goods[0] || null,
        thumbY: Number.isFinite(it.y) ? Math.max(0, Math.min(100, it.y)) : null,
      })),
      images: urls,
      manualEdit: true,
      updatedAt: Date.now(), // per-order timestamp for cloud merge (lib/syncMerge.js)
    });
    return { fixed };
  }, []);

  const fixEstimatedPrices = useCallback(async (orderId) => {
    if (syncing) return;
    const order = data.orders.find((o) => o.id === orderId);
    if (!order) return;
    setSyncing(true);
    cancelRequestedRef.current = false;
    try {
      const token = await getToken({ interactive: true });
      setGoogleSignedIn(true);
      pushLog(`Looking for a shipped/delivered email for ${orderId} with real prices…`);
      const { fixed, error } = await fetchFixedOrder(order, token);
      if (error === "no-status-email") {
        pushLog(`No status email with a priced receipt image was found for ${orderId}.`, "warn");
        return;
      }
      if (error === "no-item-image") {
        pushLog(`Found a status email for ${orderId} but couldn't find its item image.`, "warn");
        return;
      }
      const cur = dataRef.current || data; // dataRef, not the render closure — see save()
      // Same wholesale items[] replacement as rereadOrder — carry ratings
      // forward by name match (see lib/derive.js's remapRatingsAfterReplace).
      // Old items come from cur, not the `order` closure captured before the
      // vision call — an edit landing mid-call would make that copy stale.
      const oldItems = cur.orders.find((o) => o.id === orderId)?.items || order.items || [];
      const ratings = remapRatingsAfterReplace(cur.ratings, orderId, oldItems, fixed.items || []);
      await save({ ...cur, orders: cur.orders.map((o) => (o.id === orderId ? fixed : o)), ratings });
      pushLog(`✓ ${orderId}: replaced estimated prices with real ones from its status email.`, "ok");
    } catch (e) {
      pushLog("Price fix failed: " + e.message, "error");
    } finally {
      setSyncing(false);
    }
  }, [syncing, data, save, fetchFixedOrder]);

  /* ----- fix ALL estimated prices in one pass -----
     Same one-vision-call-per-order mechanism as fixEstimatedPrices, just
     looped across every order currently in the Review queue's "Estimated
     prices" bucket — one order can have several estimated ITEMS, so this
     dedupes to unique order IDs first (that's the actual API-call count and
     what the cost estimate in the UI is based on, via estimateCostPerCall in
     lib/anthropic.js). Reuses the same syncing/cancel machinery as every
     other bulk operation (sync, Reconcile, retry-failed) so the existing
     progress banner + Cancel button just work. Saves after each order
     (not just at the end) so a cancel or a crash partway through keeps
     whatever was already fixed. */
  const fixAllEstimatedPrices = useCallback(async () => {
    if (syncing) return;
    // computed fresh from data.orders (not the `review` memo below) so this
    // doesn't have to be declared after it in the component body
    const orderIds = [...new Set(reviewQueue(data.orders).estimatedItems.map((it) => it.orderId))];
    if (!orderIds.length) return;
    setSyncing(true);
    cancelRequestedRef.current = false;
    pushLog(`Fixing estimated prices for ${orderIds.length} order(s)…`);
    const base = dataRef.current || data; // dataRef, not the render closure — see save()
    let working = { ...base, orders: [...base.orders] };
    let fixedCount = 0, skippedCount = 0;
    try {
      const token = await getToken({ interactive: true });
      setGoogleSignedIn(true);
      for (let i = 0; i < orderIds.length; i++) {
        if (cancelRequestedRef.current) { pushLog(`Fix all cancelled after ${i}/${orderIds.length}.`, "warn"); break; }
        const id = orderIds[i];
        const order = working.orders.find((o) => o.id === id);
        if (!order) continue;
        pushLog(`${i + 1}/${orderIds.length}: ${id}…`);
        try {
          const { fixed, error } = await fetchFixedOrder(order, token);
          if (error) {
            pushLog(`  skipped ${id}: ${error === "no-status-email" ? "no priced status email found" : "no item image in status email"}`, "warn");
            skippedCount++;
            continue;
          }
          working = {
            ...working,
            orders: working.orders.map((o) => (o.id === id ? fixed : o)),
            // Same wholesale items[] replacement per order — carry that
            // order's ratings forward by name match.
            ratings: remapRatingsAfterReplace(working.ratings, id, order.items || [], fixed.items || []),
          };
          await save(working);
          fixedCount++;
        } catch (e) {
          pushLog(`  ${id} failed: ${e.message}`, "error");
          skippedCount++;
        }
      }
      pushLog(`Fix all complete: ${fixedCount} fixed, ${skippedCount} skipped.`, fixedCount ? "ok" : "warn");
    } catch (e) {
      pushLog("Fix all failed: " + e.message, "error");
    } finally {
      setSyncing(false);
    }
  }, [syncing, data, save, fetchFixedOrder]);

  /* ----- retry just the emails that previously errored out -----
     Complements sync()'s existing "re-read previously-empty orders" logic:
     that one catches orders that were saved with 0 items (e.g. a truncated
     vision response), while this one catches emails that threw before an
     order object was ever created (network errors, timeouts, etc). */
  const retryFailedEmails = useCallback(async () => {
    if (syncing || failedEmails.length === 0) return;
    setSyncing(true);
    cancelRequestedRef.current = false;
    pushLog(`Retrying ${failedEmails.length} failed email(s)…`);
    try {
      const token = await getToken({ interactive: true });
      setGoogleSignedIn(true);
      const base = dataRef.current || data; // dataRef, not the render closure — see save()
      const working = { ...base, orders: [...base.orders], processedIds: [...base.processedIds] };
      // Oldest-first, same reasoning as the main sync loop below.
      const toRetry = [...failedEmails].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      for (let i = 0; i < toRetry.length; i++) {
        if (cancelRequestedRef.current) { pushLog("Retry cancelled.", "warn"); break; }
        const em = toRetry[i];
        pushLog(`Retrying ${i + 1}/${toRetry.length}: ${em.id.slice(0, 10)}…`);
        await processOrderEmail(em, token, working);
        await save({ ...working });
      }
      pushLog("Retry pass complete.", "ok");
    } catch (e) {
      pushLog("Retry failed: " + e.message, "error");
    } finally {
      setSyncing(false);
    }
  }, [syncing, failedEmails, data, save, processOrderEmail]);

  /* ----- sync -----
     `full` clears all stored data and re-reads everything (destructive).
     `wide` (Reconcile) keeps all existing data but widens the search window
     to your full Gmail history regardless of lastSync, and relies on the
     hasOrder() check below to add back anything that's missing — e.g. an
     order you deleted locally to force a clean re-read, or one that was
     never caught the first time. */
  const sync = useCallback(async (full = false, { interactive = true, wide = false } = {}) => {
    if (syncing) return;
    setSyncing(true);
    cancelRequestedRef.current = false;
    setLog([]);
    try {
      const token = await getToken({ interactive });
      setGoogleSignedIn(true);
      // AWAIT the cloud connect BEFORE snapshotting `working`: the first
      // connect of a session merges the cloud copy into dataRef, and
      // building the snapshot from the pre-merge state made every save()
      // below push that stale snapshot over both local state and the cloud
      // blob — wiping edits that so far existed only in the cloud copy
      // (e.g. a "Try real prices" fix made on another device). Hits on
      // every first sync after a page load, i.e. normal daily use.
      await connectCloud(token);
      const base = dataRef.current || data;
      // unmatchedStatus is copied (it's mutated by the status pass below and
      // persisted with the blob); a full re-sync clears it along with orders/
      // processedIds — every status email gets re-applied from scratch, so
      // still-unmatched ones re-add themselves and stale rows don't linger.
      // (Cloud rows a full re-sync DID match stay gone after the post-save
      // merge: their email ids land in processedIds, which self-cleans them
      // in mergeUnmatchedStatus.)
      const working = full
        ? { ...base, orders: [], processedIds: [], unmatchedStatus: [] }
        : { ...base, orders: [...(base.orders || [])], processedIds: [...(base.processedIds || [])], unmatchedStatus: [...(base.unmatchedStatus || [])] };
      // Full re-sync rebuilds every order from fresh vision parses — the
      // same wholesale items[] replacement rereadOrder does, for every
      // order at once. Snapshot the outgoing items so ratings can be
      // re-keyed against the rebuilt arrays once the rebuild lands (the
      // remap pass after the order loop below); without this, old
      // orderId:itemIdx rating keys ride through the wipe and can attach
      // to the wrong item if a re-parse orders items differently.
      const preWipeItems = full ? new Map((base.orders || []).map((o) => [o.id, o.items || []])) : null;

      /* 1 — find Temu emails. Normal incremental syncs only search since the
         last successful sync (fast). A full re-sync, first-ever sync, or an
         explicit Reconcile searches up to 5 years back regardless of
         lastSync, since Reconcile specifically needs to be able to find an
         order whose email is much older than the last sync date. */
      const sinceClause = (!full && !wide && working.lastSync)
        ? ` after:${new Date(working.lastSync).toISOString().slice(0, 10).replace(/-/g, "/")}`
        : " newer_than:5y";
      pushLog(wide ? "Reconciling — searching your full Gmail history for Temu emails…" : "Searching Gmail for Temu emails…");

      // Temu subjects are predictable: orders = 'Your Temu order confirmation (#PO-...)',
      // status = '...delivered notification / transferred to UPS / shipped / cancelled / refund (#PO-...)'.
      // The PO number lives in the subject, so no body reading is needed for classification.
      // Temu sometimes splits a purchase into several orders and sends ONE email
      // covering all of them — subject is plural ("Your Temu orders confirmation
      // on <date>") with no PO number at all, so it must be matched separately.
      const orderQuery = `from:transaction.temu.com subject:("order confirmation" OR "orders confirmation")${sinceClause}`;
      const statusQuery = `from:transaction.temu.com subject:(delivered OR arrived OR shipped OR delivery OR "transferred to" OR cancel OR cancelled OR canceled OR refund OR return OR returned)${sinceClause}`;

      const [orderMsgs, statusMsgs] = await Promise.all([
        searchMessages(orderQuery, token),
        searchMessages(statusQuery, token),
      ]);

      const emails = [];
      for (const m of orderMsgs) {
        const meta = await getMessageMetadata(m.id, token);
        const subject = headerValue(meta, "Subject");
        const hdr = headerValue(meta, "Date");
        emails.push({
          id: m.id,
          kind: "order",
          // `at` keeps full timestamp precision for sorting; `date` stays
          // day-only for storage/display (order.date, CSV export, etc).
          at: hdr ? new Date(hdr).toISOString() : null,
          date: hdr ? new Date(hdr).toISOString().slice(0, 10) : null,
          orderId: extractPoNumber(subject),
        });
      }
      for (const m of statusMsgs) {
        const meta = await getMessageMetadata(m.id, token);
        const subject = headerValue(meta, "Subject");
        const hdr = headerValue(meta, "Date");
        // Order matters here: check cancel/refund/return before shipped/delivered.
        // "arrived" = delivered; bare "delivery" (e.g. "out for delivery",
        // "delivery update") falls through to shipped, which is correct.
        const kind = /cancel/i.test(subject) ? "cancelled"
          : /refund|return/i.test(subject) ? "returned"
          : /delivered|arrived/i.test(subject) ? "delivered"
          : "shipped";
        emails.push({
          id: m.id,
          kind,
          at: hdr ? new Date(hdr).toISOString() : null,
          date: hdr ? new Date(hdr).toISOString().slice(0, 10) : null,
          orderId: extractPoNumber(subject),
        });
      }
      pushLog(`Found ${emails.filter((e) => e.kind === "order").length} order confirmation(s), ${emails.length} Temu email(s) total.`);

      /* 2 — process order confirmations, plus retry any stored order that
         previously parsed with 0 items, plus (self-healing) re-add any order
         email that no longer has a matching stored order at all. This checks
         against the actual orders array (hasOrder) rather than the
         processedIds log — processedIds doesn't get cleaned up when an order
         is deleted, so relying on it alone would skip a deleted order forever
         even on a fresh sync. */
      const hasOrder = (id) => working.orders.some((o) => o.messageId === id);
      // Split emails share one messageId across SEVERAL orders — check every
      // sibling, not just the first match, or a partially-empty split order
      // never self-heals on a normal sync (only via explicit Reconcile).
      const isEmptyOrder = (id) => working.orders.some((o) => o.messageId === id && (!o.items || o.items.length === 0));
      const searchOrderIds = new Set(emails.filter((e) => e.kind === "order").map((e) => e.id));
      const retries = working.orders
        .filter((o) => (!o.items || o.items.length === 0) && o.messageId && !searchOrderIds.has(o.messageId))
        .map((o) => ({ id: o.messageId, kind: "order", orderId: o.id, date: o.date }));
      // Oldest-first: order-confirmation emails get read before their
      // shipped/delivered/cancelled follow-ups, and if a sync is interrupted
      // partway the earliest (most likely already-settled) orders are the
      // ones that land, rather than a scattered, out-of-order subset.
      //
      // The extra `wide && !e.orderId` clause: split-order emails (plural
      // subject, no PO number) yield SEVERAL orders from one messageId, so
      // hasOrder() saying "one exists" doesn't mean all of them do — e.g.
      // a sub-order you deleted while its siblings survived. On Reconcile,
      // re-examine every split email; processOrderEmail skips sub-orders
      // that are already stored (cheap Gmail fetch, no vision calls), so
      // this only pays for what's actually missing.
      const newOrders = [
        ...emails.filter((e) => e.kind === "order" && (!hasOrder(e.id) || isEmptyOrder(e.id) || (wide && !e.orderId))),
        ...retries,
      ].sort((a, b) => (a.at || a.date || "").localeCompare(b.at || b.date || ""));
      if (retries.length) pushLog(`Retrying ${retries.length} previously-empty order(s).`);
      for (let i = 0; i < newOrders.length; i++) {
        if (cancelRequestedRef.current) { pushLog("Sync cancelled — stopping before next email.", "warn"); break; }
        const em = newOrders[i];
        pushLog(`Reading order email ${i + 1}/${newOrders.length}…`);
        await processOrderEmail(em, token, working);
        await save({ ...working });
      }
      if (preWipeItems) {
        // Re-key each rebuilt order's ratings against its freshly-parsed
        // items (drop-don't-misattach — see remapRatingsAfterReplace).
        // Ratings for orders that didn't come back sit in the map
        // harmlessly (keys are never deleted, and ratingQueues only reads
        // keys whose order/item exist).
        for (const [oid, oldItems] of preWipeItems) {
          const rebuilt = working.orders.find((o) => o.id === oid);
          if (rebuilt) working.ratings = remapRatingsAfterReplace(working.ratings, oid, oldItems, rebuilt.items || []);
        }
        await save({ ...working });
      }

      /* 3 — status updates: shipped / delivered / cancelled / returned.

         Normal syncs skip already-processed status emails. A Reconcile
         (wide) deliberately RE-APPLIES every status email in history:
         older versions marked unmatched status emails as processed even
         when their order didn't exist yet (classic case: split-email
         sub-orders parsed after their delivered email), stranding orders
         at "ordered" forever. Re-running is cheap — metadata + occasional
         body fetch, no vision calls — and idempotent, since oldest-first
         ordering means the newest status wins. */
      if (!cancelRequestedRef.current) {
        // Sort by full timestamp (`at`), not day-only `date`: same-day status
        // emails are common (e.g. "out for delivery" a few hours before
        // "delivered"), and day-only precision left same-day entries in
        // whatever order Gmail's search API happened to return them —
        // occasionally applying an earlier-in-the-day "shipped"/"out for
        // delivery" email AFTER that same day's "delivered" one and flipping
        // the order back to shipped. `at` (full ISO timestamp) restores the
        // real chronological order so the true latest status always wins.
        const statusEmails = emails
          .filter((e) => e.kind !== "order" && (wide || !working.processedIds.includes(e.id)))
          .sort((a, b) => (a.at || a.date || "").localeCompare(b.at || b.date || ""));
        if (wide && statusEmails.length) pushLog(`Re-applying ${statusEmails.length} status email(s) from history…`);
        let statApplied = 0;
        let statUnmatched = 0;
        for (const em of statusEmails) {
          if (cancelRequestedRef.current) { pushLog("Sync cancelled — stopping before next email.", "warn"); break; }
          let oid = em.orderId;
          let html = null;
          let tracking = null;
          let matchedByTracking = false;
          // Fetch the body when the PO isn't in the subject (to find it), and
          // for shipped emails regardless — they carry the estimated-arrival
          // window and the carrier tracking link. Cheap regex, no Claude call.
          if (!oid || em.kind === "shipped") {
            try {
              const fullMsg = await getMessageFull(em.id, token);
              html = extractHtml(fullMsg.payload);
              // parent_order_sn in the tracking link is exact — the first-PO-
              // in-raw-HTML approach could grab a SIBLING order's number.
              if (!oid) oid = extractPoFromBody(html);
              tracking = extractTracking(html);
              // Some status emails never mention the PO anywhere at all — e.g.
              // Temu's forwarded "UPS My Choice" delivery notifications
              // (subject "Your package has been delivered", no PO in subject
              // OR body). They DO carry the carrier tracking number as plain
              // text, and that same number was already recorded on the order
              // by its earlier "shipped" email (which does carry the PO) — so
              // fall back to matching an existing order by tracking number.
              if (!oid && tracking?.number) {
                const byTracking = working.orders.find((o) => o.tracking?.number === tracking.number);
                if (byTracking) { oid = byTracking.id; matchedByTracking = true; }
              }
            } catch { /* skip */ }
          }
          const target = oid && working.orders.find((o) => o.id === oid);
          if (target) {
            target.status = em.kind;
            // The EMAIL's own date, not sync time — a Reconcile can apply a
            // backlog of old status emails in one pass (or the app might
            // just not be opened for a while), so "when we happened to
            // process this" can be days after the real event. Used by
            // arrivingCalendar's "Recently Delivered" (see deliveredAtFor
            // in lib/derive.js) instead of updatedAt for exactly that
            // reason — updatedAt still separately tracks sync/cloud-merge
            // bookkeeping below and stays as-is for that purpose.
            target.statusEmailAt = em.at || em.date || target.statusEmailAt;
            if (html) {
              const eta = extractEta(html);
              if (eta) target.eta = eta;
              if (tracking) target.tracking = tracking;
              // Replace missing OR stale (pre-fix, wrong-anchor) links.
              if (!isOrderDetailLink(target.orderUrl)) {
                target.orderUrl = extractOrderLink(html, target.id) || target.orderUrl;
              }
            }
            target.updatedAt = Date.now(); // per-order timestamp for cloud merge (lib/syncMerge.js)
            statApplied++;
            pushLog(`✓ ${oid} → ${em.kind}${matchedByTracking ? " (matched by tracking #, no PO in email)" : ""}${em.kind === "shipped" && target.eta ? ` (est. ${target.eta})` : ""}${em.kind === "shipped" && target.tracking?.carrier ? ` · ${target.tracking.carrier}` : ""}`, "ok");
            if (!working.processedIds.includes(em.id)) working.processedIds.push(em.id);
            // Matched → any Review-queue row for this email OR this order is
            // obsolete. Removed from the working blob (persisted at save) so
            // it stays gone; the cloud merge can't resurrect it either, since
            // the email is now processed and the order exists — both
            // self-cleaning rules in mergeUnmatchedStatus (lib/syncMerge.js).
            working.unmatchedStatus = working.unmatchedStatus.filter((x) => x.id !== em.id && x.oid !== oid);
          } else {
            // Deliberately NOT marked processed: if the order confirmation
            // failed to parse this run (or hasn't been read yet), marking
            // this processed would strand the order at "ordered" forever.
            // Recorded in unmatchedStatus so the Review queue can show it
            // and offer a targeted "find & import" of the missing order.
            statUnmatched++;
            pushLog(`✗ ${em.kind} email has no matching order${oid ? ` (${oid})` : tracking?.number ? ` (no PO, tracking ${tracking.number} matches no stored order)` : " (no PO found in it)"} — see Needs review.`, "warn");
            // Deduped by email id — the same row may already be here from a
            // previous run, a Reconcile re-pass, or a headless gmail-sync run
            // (same row shape, merged in from the cloud blob).
            if (!working.unmatchedStatus.some((x) => x.id === em.id)) {
              working.unmatchedStatus.push({ id: em.id, oid: oid || null, kind: em.kind, date: em.date, trackingNumber: tracking?.number || null });
            }
          }
        }
        if (statApplied || statUnmatched) {
          pushLog(`Status pass: ${statApplied} applied, ${statUnmatched} unmatched${statUnmatched ? " — their orders are missing from the store (likely unparsed split-email sub-orders); use Needs review → Find & import" : ""}.`, statUnmatched ? "warn" : "ok");
        }
      }

      // Only advance lastSync on a clean, uncancelled run — if the user
      // cancelled partway, leave it alone so the next sync re-scans the
      // same window and picks up whatever didn't get processed (already-done
      // emails are skipped via processedIds either way).
      if (!cancelRequestedRef.current) working.lastSync = new Date().toISOString();
      await save({ ...working });
      pushLog(
        cancelRequestedRef.current ? "Sync cancelled — partial progress saved." : (wide ? "Reconcile complete." : "Sync complete."),
        cancelRequestedRef.current ? "warn" : "ok"
      );
    } catch (e) {
      pushLog("Sync failed: " + e.message, "error");
    } finally {
      setSyncing(false);
    }
  }, [data, syncing, save, processOrderEmail, connectCloud]);

  const cancelSync = useCallback(() => {
    cancelRequestedRef.current = true;
    cancelCurrentCall();
    pushLog("Cancelling — stopping after the current email…", "warn");
  }, []);

  /* auto-sync on open if stale > 12h — only if already signed in to Google,
     since an interactive OAuth popup can't be triggered without a user
     gesture (and would be blocked by the browser on page load). */
  useEffect(() => {
    if (!loaded || syncing) return;
    if (data.autoSync && (!data.lastSync || Date.now() - new Date(data.lastSync) > 12 * 3600e3)) {
      if (isSignedIn()) {
        sync(false, { interactive: false });
      } else {
        pushLog("Auto-sync skipped — sign in to Google (Settings, or hit Check Gmail) first.");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  /* ----- derived data -----
     allItems includes every item from every order (so item views can
     still show/filter/edit cancelled or returned items on request), with
     thumbnail-crop annotations and the item's index within its order (so
     the mobile quick-edit can address it); active* variants exclude
     cancelled/returned and feed stats, so refunded stuff doesn't inflate
     spend. */
  const allItems = useMemo(() => {
    const rows = [];
    for (const o of data.orders) {
      annotateThumbs(o.items || []).forEach((it, itemIdx) => {
        rows.push({ ...it, orderId: o.id, date: o.date, status: o.status || "ordered", itemIdx });
      });
    }
    return rows;
  }, [data.orders]);

  const activeOrders = useMemo(() => data.orders.filter((o) => isActiveStatus(o.status || "ordered")), [data.orders]);
  const activeItems = useMemo(() => allItems.filter((i) => isActiveStatus(i.status)), [allItems]);
  // Items excluded from Analytics only (e.g. a one-off expensive gift) —
  // never hidden from the Items/Orders views, just from item-driven stats
  // (top items, category spend, price histogram, saved/avg-discount).
  // Order-level figures (charged spend, funnel, carrier, delivery time)
  // read activeOrders directly and are unaffected either way.
  const ignoredAnalyticsSet = useMemo(() => new Set(ignoredAnalytics), [ignoredAnalytics]);
  const analyticsItems = useMemo(
    () => activeItems.filter((i) => !ignoredAnalyticsSet.has(analyticsItemKey(i))),
    [activeItems, ignoredAnalyticsSet]
  );
  const ignoredAnalyticsItems = useMemo(
    () => activeItems.filter((i) => ignoredAnalyticsSet.has(analyticsItemKey(i)))
      .map((it) => ({ ...it, amount: (it.paid || 0) * (it.qty || 1) }))
      .sort((a, b) => b.amount - a.amount),
    [activeItems, ignoredAnalyticsSet]
  );
  const stats = useMemo(() => buildStats(data.orders, activeOrders, analyticsItems, carrier), [data.orders, activeOrders, analyticsItems, carrier]);
  const review = useMemo(() => reviewQueue(data.orders), [data.orders]);
  const inTransit = useMemo(() => inTransitOrders(data.orders), [data.orders]);
  // freeItems reads analyticsItems (active + ignore-list filtered), so an
  // ignored item disappears from this list too, not just the item-driven
  // stats above.
  const receivedFreeItems = useMemo(() => freeItems(analyticsItems), [analyticsItems]);
  const ratingQueuesData = useMemo(
    () => ratingQueues(data.orders, data.ratings || {}, carrier),
    [data.orders, data.ratings, carrier]
  );

  /* ----- ctx: everything the shells need ----- */
  const ctx = {
    data, save, loaded,
    syncing, sync, cancelSync,
    log, pushLog,
    failedEmails, retryFailedEmails, rereadOrder, testConnection,
    unmatchedStatus: data.unmatchedStatus || [], importMissingOrder, fixEstimatedPrices, fixAllEstimatedPrices,
    googleSignedIn, handleGoogleSignIn, handleGoogleSignOut,
    apiKeyInput, setApiKeyInput, saveApiKey,
    thumbSize, updateThumbSize,
    exportData, importData, exportItemsCsv, exportOrdersCsv,
    editingId, editDraft, setEditDraft, startEdit, cancelEdit, saveEdit,
    updateItem, deleteOrder, openOrderPage,
    query, setQuery,
    allItems, activeOrders, activeItems, stats, review, inTransit,
    ignoredAnalyticsItems, toggleIgnoreAnalyticsItem, receivedFreeItems,
    ratings: data.ratings || {}, rateItem, toggleBuyAgain, ratingQueues: ratingQueuesData,
    lightbox, setLightbox,
    layoutOverride, setLayoutOverride,
    cloudState, cloudDirty, carrier,
    pushConfigured: pushConfigured(), pushSupport, pushEnabled, pushBusy, pushNeedsInstall, togglePush,
    openWelcome,
    isAdmin, directory, directoryError, loadDirectory,
    adminViewUid, adminViewState, adminViewLoading, viewUserData, exitAdminView,
  };

  return (
    <>
      {mode === "mobile" ? <MobileShell c={ctx} /> : <DesktopShell c={ctx} />}
      <Lightbox url={lightbox} onClose={() => setLightbox(null)} />
      {showWelcome && <WelcomeModal onClose={closeWelcome} />}
    </>
  );
}
