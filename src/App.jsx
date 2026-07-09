import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";

import { storage } from "./lib/storage";
import { downloadCsv, itemsCsv, ordersCsv } from "./lib/exportCsv";
import { applyDiscounts } from "./lib/discounts";
import { callClaude, cancelCurrentCall, textOf, extractJSON, getApiKey, setApiKey } from "./lib/anthropic";
import { getToken, getStoredToken, isSignedIn, signIn, signOut } from "./lib/gis";
import { cloudConfigured, cloudSignIn, cloudSignOut, cloudGet, cloudSet, cloudSubscribe, cloudSubscribeCarrier } from "./lib/firebase";
import {
  searchMessages, getMessageMetadata, getMessageFull, headerValue,
  extractHtml, extractSection, extractAllSections, extractImgSrcs, extractPoNumber, extractSubOrders,
  extractOrderLink, extractEta, isOrderDetailLink, extractPoFromBody, extractTracking,
} from "./lib/gmail";
import { buildStats, reviewQueue, inTransitOrders, isActiveStatus } from "./lib/derive";
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

export default function App() {
  const [data, setData] = useState({ orders: [], processedIds: [], lastSync: null, autoSync: true });
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [log, setLog] = useState([]);
  const [query, setQuery] = useState("");
  const [lightbox, setLightbox] = useState(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState(() => getApiKey());
  const [googleSignedIn, setGoogleSignedIn] = useState(() => isSignedIn());
  const [failedEmails, setFailedEmails] = useState([]);
  const [unmatchedStatus, setUnmatchedStatus] = useState([]); // status emails with no matching order
  const [thumbSize, setThumbSize] = useState(() => Number(localStorage.getItem(THUMB_SIZE_KEY)) || THUMB_SIZE_DEFAULT);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const cancelRequestedRef = useRef(false);
  const { mode, override: layoutOverride, setLayoutOverride } = useLayoutMode();

  /* ----- cloud sync (optional Firebase RTDB) -----
     "unconfigured" = no VITE_FIREBASE_* env vars, feature invisible.
     "off" → "connecting" → "on" | "error" once configured. */
  const [cloudState, setCloudState] = useState(() => (cloudConfigured() ? "off" : "unconfigured"));
  const [carrier, setCarrier] = useState({}); // trackingNumber → live 17TRACK info (from the GitHub Action)
  const cloudReadyRef = useRef(false);      // gate write-through in save()
  const cloudConnectingRef = useRef(false); // connect() is idempotent
  const cloudUnsubRef = useRef(null);
  const cloudCarrierUnsubRef = useRef(null);
  const dataRef = useRef(null);             // latest data, for callbacks
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
    setData(stamped);
    const json = JSON.stringify(stamped);
    try { await storage.set(STORAGE_KEY, json); }
    catch (e) { pushLog("Save failed: " + e.message, "error"); }
    if (cloudReadyRef.current) {
      cloudSet(json, stamped.updatedAt).catch((e) => pushLog("Cloud save failed (kept locally): " + e.message, "warn"));
    }
  }, []);

  /* Connect the optional Firebase layer using the SAME Google access token
     the app already holds for Gmail. Pull-newer on connect, then live
     listener. Idempotent — called from every place a token shows up. */
  const connectCloud = useCallback(async (token) => {
    if (!cloudConfigured() || !token || cloudConnectingRef.current) return;
    cloudConnectingRef.current = true;
    setCloudState("connecting");
    try {
      await cloudSignIn(token);
      const remote = await cloudGet();
      const local = dataRef.current || {};
      if (remote?.json && (remote.updatedAt || 0) > (local.updatedAt || 0)) {
        const parsed = JSON.parse(remote.json);
        setData((d) => ({ ...d, ...parsed }));
        storage.set(STORAGE_KEY, remote.json).catch(() => {});
        pushLog(`Cloud: pulled newer data (${parsed.orders?.length ?? 0} orders) from Firebase.`, "ok");
      } else if ((local.orders?.length || local.updatedAt) && (!remote || (local.updatedAt || 0) > (remote.updatedAt || 0))) {
        await cloudSet(JSON.stringify(local), local.updatedAt || Date.now());
        pushLog("Cloud: uploaded local data to Firebase.", "ok");
      }
      cloudUnsubRef.current = await cloudSubscribe((val) => {
        if (!val?.json) return;
        if ((val.updatedAt || 0) <= (dataRef.current?.updatedAt || 0)) return; // our own write, or stale
        if (syncingRef.current) {
          // A sync is writing from its own snapshot — applying a remote
          // change now would be clobbered by the next loop save anyway.
          pushLog("Cloud: remote change arrived mid-sync — this device's sync results will win.", "warn");
          return;
        }
        try {
          const parsed = JSON.parse(val.json);
          setData((d) => ({ ...d, ...parsed }));
          storage.set(STORAGE_KEY, val.json).catch(() => {});
          pushLog("Cloud: updated from another device.", "ok");
        } catch { /* malformed remote payload — ignore */ }
      });
      // Live carrier ETAs (written by the scheduled GitHub Action) — read-only.
      try {
        cloudCarrierUnsubRef.current = await cloudSubscribeCarrier(setCarrier);
      } catch { /* carrier data optional */ }
      cloudReadyRef.current = true;
      setCloudState("on");
    } catch (e) {
      cloudConnectingRef.current = false; // allow retry on next token
      setCloudState("error");
      pushLog("Cloud sync failed: " + e.message + " — data stays local. Check the Firebase setup in README.", "warn");
    }
  }, []);

  /* If already signed in from a previous session, connect cloud on open. */
  useEffect(() => {
    if (loaded && isSignedIn()) connectCloud(getStoredToken());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  /* Carrier truth → order status. When the tracking worker reports a
     package Delivered but the order still says "shipped" (Temu's delivered
     email not synced yet, or matched wrong in an old sync), promote the
     order automatically instead of waiting for an email pass. Idempotent:
     once promoted, the filter matches nothing. */
  useEffect(() => {
    if (!loaded || syncing) return;
    const done = data.orders.filter(
      (o) => (o.status || "ordered") === "shipped" && o.tracking?.number && carrier[o.tracking.number]?.status === "Delivered"
    );
    if (!done.length) return;
    const ids = new Set(done.map((o) => o.id));
    save({ ...data, orders: data.orders.map((o) => (ids.has(o.id) ? { ...o, status: "delivered" } : o)) });
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
    cloudConnectingRef.current = false;
    cloudSignOut();
    if (cloudConfigured()) setCloudState("off");
    pushLog("Signed out of Google.");
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
    };
    save({ ...data, orders: data.orders.map((o) => (o.id === cleaned.id ? cleaned : o)) });
    pushLog(`Saved manual edits to ${cleaned.id}.`, "ok");
    setEditingId(null);
    setEditDraft(null);
  }, [editDraft, data, save, syncing]);

  /* ----- quick single-item edit (mobile detail sheet) ----- */
  const updateItem = useCallback((orderId, itemIdx, patch) => {
    if (syncing) { pushLog("Can't save edits while a sync is running.", "warn"); return; }
    const orders = data.orders.map((o) => {
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
      return { ...o, items, manualEdit: true };
    });
    save({ ...data, orders });
    pushLog(`Saved item edit in ${orderId}.`, "ok");
  }, [data, save, syncing]);

  const deleteOrder = useCallback((id) => {
    if (syncing) return;
    save({ ...data, orders: data.orders.filter((x) => x.id !== id) });
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
          save({ ...data, orders: data.orders.map((o) => (o.id === order.id ? { ...o, orderUrl: link } : o)) });
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
      const working = { ...data, orders: [...data.orders], processedIds: [...data.processedIds] };
      pushLog(`Re-reading ${order.id} from its email…`);
      const em = {
        id: order.messageId,
        kind: "order",
        orderId: /^PO-/.test(order.id) ? order.id : null,
        date: order.date,
      };
      await processOrderEmail(em, token, working, { forceId: order.id });
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
      const working = { ...data, orders: [...data.orders], processedIds: [...data.processedIds] };
      await processOrderEmail(found, token, working, { forceId: po });
      if (working.orders.some((o) => o.id === po)) {
        await save({ ...working });
        setUnmatchedStatus((u) => u.filter((x) => x.oid !== po));
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
     call) — triggered from the Review queue's "Estimated prices" list. The
     result is marked manualEdit so a later re-read of the (still priceless)
     split confirmation can't silently revert it back to an estimate. */
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
      const msgs = await searchMessages(
        `from:transaction.temu.com subject:(shipped OR delivered OR arrived OR "transferred to" OR delivery) "${orderId}"`,
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
      if (!html) {
        pushLog(`No status email with a priced receipt image was found for ${orderId}.`, "warn");
        return;
      }
      const goods = extractImgSrcs(extractSection(html, "goods_list")).filter((u) => /^https?:\/\//.test(u));
      const pay = extractImgSrcs(extractSection(html, "order_pay_info_row")).filter((u) => /^https?:\/\//.test(u));
      if (!goods.length) {
        pushLog(`Found a status email for ${orderId} but couldn't find its item image.`, "warn");
        return;
      }
      pushLog(`Re-reading ${orderId}'s real prices from its status email…`);
      const urls = [...goods, ...pay];
      // Orders re-consolidated from a split-purchase sub-order can run to
      // 15-20+ items — the default 2000-token budget (see anthropic.js)
      // truncated the JSON mid-response for a real case like this. Full
      // item + price + category JSON for a big order needs more headroom.
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
      });
      await save({ ...data, orders: data.orders.map((o) => (o.id === orderId ? fixed : o)) });
      pushLog(`✓ ${orderId}: replaced estimated prices with real ones from its status email.`, "ok");
    } catch (e) {
      pushLog("Price fix failed: " + e.message, "error");
    } finally {
      setSyncing(false);
    }
  }, [syncing, data, save]);

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
      const working = { ...data, orders: [...data.orders], processedIds: [...data.processedIds] };
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
    const working = full
      ? { ...data, orders: [], processedIds: [] }
      : { ...data, orders: [...data.orders], processedIds: [...data.processedIds] };
    try {
      const token = await getToken({ interactive });
      setGoogleSignedIn(true);
      connectCloud(token);

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
      const isEmptyOrder = (id) => {
        const o = working.orders.find((x) => x.messageId === id);
        return o && (!o.items || o.items.length === 0);
      };
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
            if (html) {
              const eta = extractEta(html);
              if (eta) target.eta = eta;
              if (tracking) target.tracking = tracking;
              // Replace missing OR stale (pre-fix, wrong-anchor) links.
              if (!isOrderDetailLink(target.orderUrl)) {
                target.orderUrl = extractOrderLink(html, target.id) || target.orderUrl;
              }
            }
            statApplied++;
            pushLog(`✓ ${oid} → ${em.kind}${matchedByTracking ? " (matched by tracking #, no PO in email)" : ""}${em.kind === "shipped" && target.eta ? ` (est. ${target.eta})` : ""}${em.kind === "shipped" && target.tracking?.carrier ? ` · ${target.tracking.carrier}` : ""}`, "ok");
            if (!working.processedIds.includes(em.id)) working.processedIds.push(em.id);
            setUnmatchedStatus((u) => u.filter((x) => x.id !== em.id && x.oid !== oid));
          } else {
            // Deliberately NOT marked processed: if the order confirmation
            // failed to parse this run (or hasn't been read yet), marking
            // this processed would strand the order at "ordered" forever.
            // Recorded in unmatchedStatus so the Review queue can show it
            // and offer a targeted "find & import" of the missing order.
            statUnmatched++;
            pushLog(`✗ ${em.kind} email has no matching order${oid ? ` (${oid})` : tracking?.number ? ` (no PO, tracking ${tracking.number} matches no stored order)` : " (no PO found in it)"} — see Needs review.`, "warn");
            setUnmatchedStatus((u) => (u.some((x) => x.id === em.id) ? u : [...u, { id: em.id, oid: oid || null, kind: em.kind, date: em.date, trackingNumber: tracking?.number || null }]));
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
  const stats = useMemo(() => buildStats(data.orders, activeOrders, activeItems, carrier), [data.orders, activeOrders, activeItems, carrier]);
  const review = useMemo(() => reviewQueue(data.orders), [data.orders]);
  const inTransit = useMemo(() => inTransitOrders(data.orders), [data.orders]);

  /* ----- ctx: everything the shells need ----- */
  const ctx = {
    data, save, loaded,
    syncing, sync, cancelSync,
    log, pushLog,
    failedEmails, retryFailedEmails, rereadOrder, testConnection,
    unmatchedStatus, importMissingOrder, fixEstimatedPrices,
    googleSignedIn, handleGoogleSignIn, handleGoogleSignOut,
    apiKeyInput, setApiKeyInput, saveApiKey,
    thumbSize, updateThumbSize,
    exportData, importData, exportItemsCsv, exportOrdersCsv,
    editingId, editDraft, setEditDraft, startEdit, cancelEdit, saveEdit,
    updateItem, deleteOrder, openOrderPage,
    query, setQuery,
    allItems, activeOrders, activeItems, stats, review, inTransit,
    lightbox, setLightbox,
    layoutOverride, setLayoutOverride,
    cloudState, carrier,
    openWelcome,
  };

  return (
    <>
      {mode === "mobile" ? <MobileShell c={ctx} /> : <DesktopShell c={ctx} />}
      <Lightbox url={lightbox} onClose={() => setLightbox(null)} />
      {showWelcome && <WelcomeModal onClose={closeWelcome} />}
    </>
  );
}
