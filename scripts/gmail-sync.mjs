/* ============================================================
   Headless Gmail sync — runs in GitHub Actions on a schedule
   (.github/workflows/gmail-sync.yml), NOT in the browser.

   A server-side port of the app's incremental sync (src/App.jsx →
   sync(), non-full, non-wide): search Gmail for new Temu emails
   since lastSync, vision-parse new order confirmations (including
   split-order emails), apply status emails oldest-first with the
   app's exact matching fallbacks, then merge the result back into
   Firebase RTDB exactly like another device would (per-order
   updatedAt merge via src/lib/syncMerge.js) and send FCM pushes
   for what changed THIS run.

   Gmail auth: a long-lived OAuth refresh token (minted once with
   scripts/gmail-auth.mjs) exchanged for a fresh access token at
   the top of every run — no interactive consent, no GIS.

   Invariants preserved from the app (see CLAUDE.md → Key
   mechanisms — don't "fix" these without reading it):
   - manualEdit orders are never overwritten by a re-read path
     (there is no forceId here at all — Re-read stays app-only).
   - per-order `updatedAt` is stamped at every mutation; the write
     back is mergeState() over a RE-FETCHED cloud state, so a phone
     saving mid-run never gets clobbered.
   - `statusEmailAt` comes from the email's own date, never run time.
   - status emails apply oldest-first by full timestamp (`at`), with
     subject-PO → parent_order_sn-in-body → tracking-number fallbacks.
   - estimated/listedUnknown semantics come from applyDiscounts
     (imported, not reimplemented).
   - unmatched status emails are NOT marked processed; they're
     recorded in the state blob's `unmatchedStatus` list.
   - fixEstimatedPrices stays manual-only in the app — deliberately
     NOT ported here.

   Spend guard: MAX_VISION_PER_RUN (default 20) caps Claude vision
   calls per run. When the cap is hit, the remaining order emails
   are simply left unprocessed AND lastSync is NOT advanced, so the
   next run's search window still contains them — they queue up,
   they never get lost, and they're never marked processed early.

   Structure note: the pipeline pieces (processOrderEmail,
   applyStatusEmails, …) are exported with injectable fetchers so
   an offline test can drive them against fixture HTML + canned
   vision JSON; main() only runs when the file is executed directly
   (firebase-admin is dynamic-imported there — it's installed by
   the workflow via `npm install --no-save`, not in package.json).
   ============================================================ */

import { pathToFileURL } from "node:url";
import { sendPushes } from "./push.mjs";
// These src/lib modules are pure ESM with no browser globals in any code
// path this script calls (verified: Node 20 has fetch/atob/TextDecoder) —
// import them so the extraction regexes, discount semantics and merge
// logic can never drift from the app's.
import {
  searchMessages, getMessageMetadata, getMessageFull, headerValue,
  extractHtml, extractSection, extractAllSections, extractImgSrcs,
  extractPoNumber, extractSubOrders, extractOrderLink, extractEta,
  isOrderDetailLink, extractPoFromBody, extractTracking,
} from "../src/lib/gmail.js";
import { applyDiscounts } from "../src/lib/discounts.js";
import { mergeState } from "../src/lib/syncMerge.js";
// anthropic.js's extractJSON is pure; its callClaude is NOT usable here
// (it reads the API key from localStorage), so a minimal Node equivalent
// lives below with the same model + request shape.
import { extractJSON } from "../src/lib/anthropic.js";

// Copied from src/components/shared.jsx (that module imports lucide-react +
// JSX, so it can't load under plain Node). Keep in sync — the vision prompts
// interpolate this list and the app validates categories against it.
export const CATEGORIES = ["Tools", "Home", "Kitchen", "Outdoors", "Electronics", "Clothing", "Toys", "Auto", "Crafts", "Sports", "Other"];
// Copied from src/components/shared.jsx (same reason).
const fmt = (n) => (n == null || isNaN(n) ? "—" : "$" + Number(n).toFixed(2));

const APP_URL = "https://shutuppetey.github.io/TemuDashboard/";
const MODEL = "claude-sonnet-5"; // same as src/lib/anthropic.js
const MAX_VISION_PER_RUN = Number(process.env.MAX_VISION_PER_RUN || 20);

/* ---------------- Gmail token refresh ---------------- */

/* The GIS implicit-flow token the app uses lives ~1h and needs a browser.
   Here we hold a refresh token (offline access, minted once by
   scripts/gmail-auth.mjs) and trade it for a fresh access token per run. */
async function refreshGmailToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) {
    // A revoked/expired refresh token is a config error, not a transient
    // failure — fail loudly so the run shows red and the user re-mints it.
    throw new Error(`Gmail token refresh failed (HTTP ${res.status}): ${JSON.stringify(j || "").slice(0, 200)} — re-run scripts/gmail-auth.mjs and update the GMAIL_REFRESH_TOKEN secret.`);
  }
  return j.access_token;
}

/* ---------------- Claude vision (Node) ---------------- */

/* Same request shape as src/lib/anthropic.js → callClaude, minus the
   browser-only bits (localStorage key, CORS header, cancel plumbing).
   Image inputs stay URL sources — Anthropic fetches Temu's signed image
   URLs server-side, same as it does for the browser app. */
async function callClaude(userContent, { timeoutMs = 150000, maxTokens = 2000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: userContent }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${text}`.slice(0, 200));
    }
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Claude call timed out after ${timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- run bookkeeping ---------------- */

/* One per run: what changed (for the push messages + "write nothing if
   nothing changed" check) and how much vision budget was spent. */
export function newRunCounters() {
  return {
    newOrders: [],       // [{id, total}] — orders created THIS run (grouped push)
    statusChanges: [],   // [{id, kind, item}] — real transitions THIS run (one push each)
    visionCalls: 0,
    orderFails: 0,
    budgetTruncated: false,
    statusApplied: 0,
    statusUnmatched: 0,
    mutations: 0,        // any change that makes the blob worth writing back
  };
}

/* Subject → status bucket. Copied logic from src/App.jsx sync() step 1:
   order matters — check cancel/refund/return before shipped/delivered;
   "arrived" = delivered; bare "delivery" (e.g. "out for delivery",
   "delivery update") falls through to shipped, which is correct. */
export function classifyStatusSubject(subject) {
  return /cancel/i.test(subject) ? "cancelled"
    : /refund|return/i.test(subject) ? "returned"
    : /delivered|arrived/i.test(subject) ? "delivered"
    : "shipped";
}

/* ---------------- order-confirmation email processing ----------------
   Port of src/App.jsx → processOrderEmail (the non-forceId path only —
   forced re-reads are an interactive app feature). Mutates `working` in
   place on success. Returns "ok" | "failed" | "budget". The vision
   prompts are copied VERBATIM from App.jsx — they're carefully worded
   (JSON-only, gi/y thumbnail coordinates, null over guessing); change
   them there first if ever, then re-copy.
   deps = { fetchFull, vision, budget } — injectable for offline tests. */
export async function processOrderEmail(em, token, working, run, deps = {}) {
  const { fetchFull = getMessageFull, vision = callClaude, budget = MAX_VISION_PER_RUN } = deps;
  const saveOrder = (order) => {
    const dupIdx = working.orders.findIndex((o) => o.id === order.id);
    if (dupIdx >= 0) {
      const old = working.orders[dupIdx];
      // Hand-edited orders are never silently overwritten by a re-read —
      // only the app's explicit Re-read button (forceId) may replace them,
      // and that path doesn't exist headless.
      if (old.manualEdit && old.items?.length) return;
      // Keep status/eta/link learned from later status emails — a re-read
      // of the confirmation email shouldn't clobber them.
      working.orders[dupIdx] = { ...order, status: old.status, eta: order.eta || old.eta, orderUrl: order.orderUrl || old.orderUrl };
      run.mutations++;
    } else {
      working.orders.push(order);
      run.newOrders.push({ id: order.id, total: order.total });
      run.mutations++;
    }
  };
  try {
    /* Each Temu order email marks the sections that matter with HTML
       comments: goods_list (item rows rendered as one PNG) and
       order_pay_info_row (payment summary). Everything else is marketing.
       Some emails bundle several orders into ONE message ("Your Temu
       orders confirmation..." — plural subject, no PO number in it). Each
       sub-order there gets its own goods_list image, but there's only one
       combined payment summary for the whole message. */
    const fullMsg = await fetchFull(em.id, token);
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
        console.warn(`  split-order email has ${subOrders.length} orders but ${goodsSections.length} item image(s) — matching by position, some may be off.`);
      }
      let readCount = 0;
      for (let i = 0; i < subOrders.length; i++) {
        const sub = subOrders[i];
        // Per-sub-order gating: one split email yields several orders. If
        // this sub-order is already stored with items, skip it — no vision
        // call. This also makes a budget-interrupted split email cheap to
        // resume: next run re-fetches the email but only pays for the
        // sub-orders that are still missing.
        const existing = working.orders.find((o) => o.id === sub.orderId);
        if (existing && existing.items?.length) continue;
        const goods = extractImgSrcs(goodsSections[i] || "").filter((u) => /^https?:\/\//.test(u));
        if (!goods.length) {
          console.warn(`  ${sub.orderId}: no item image found, skipping.`);
          continue;
        }
        if (run.visionCalls >= budget) {
          // Budget hit mid-split: sub-orders already parsed above stay in
          // `working` (they're real), but the email is NOT marked processed
          // so the remaining siblings get picked up next run.
          run.budgetTruncated = true;
          console.log(`  vision budget (${budget}) reached mid-split — remaining sub-orders wait for the next run.`);
          return "budget";
        }
        run.visionCalls++;
        readCount++;
        const parsed = extractJSON(await vision([
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
        console.log(`  ✓ ${order.id} (${i + 1}/${subOrders.length} in split email): ${order.items.length} items, ${fmt(order.total)}`);
      }
      if (readCount === 0) console.log(`  split email checked — all ${subOrders.length} sub-orders already present.`);
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
        console.error(`  ⚠ Email ${em.id.slice(0, 10)}… has ${goodsSectionCount} item images but no readable sub-order IDs — split-email format not recognized; only the first order will be captured. See CLAUDE.md → Open threads #1.`);
      }
      const goods = extractImgSrcs(extractSection(html, "goods_list")).filter((u) => /^https?:\/\//.test(u));
      const pay = extractImgSrcs(extractSection(html, "order_pay_info_row")).filter((u) => /^https?:\/\//.test(u));
      if (!goods.length) throw new Error("goods_list image not found in email HTML");

      if (run.visionCalls >= budget) {
        run.budgetTruncated = true;
        return "budget";
      }
      run.visionCalls++;
      const urls = [...goods, ...pay];
      // Orders can run to 15-20+ items — the default 2000-token budget
      // can truncate the JSON mid-response for a big one.
      const parsed = extractJSON(await vision([
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
      console.log(`  ✓ ${order.id}: ${order.items.length} items, ${fmt(order.total)}`);
    }

    if (!working.processedIds.includes(em.id)) {
      working.processedIds.push(em.id);
      run.mutations++;
    }
    return "ok";
  } catch (e) {
    // Individual email failures must not kill the run (same tolerance as
    // the app's failedEmails list). Because lastSync is held back below
    // whenever this happens, the next run's window still contains this
    // email and it gets retried automatically — the headless analogue of
    // the app's manual "Retry failed" button.
    console.error(`  ✗ order email failed (${em.id.slice(0, 10)}…): ${e.message}`);
    run.orderFails++;
    return "failed";
  }
}

/* ---------------- status-email application ----------------
   Straight port of the app's status pass (src/App.jsx sync() step 3,
   non-wide). Caller pre-filters processed emails and pre-sorts
   oldest-first by `at` — same-day status emails MUST apply in real
   chronological order or an earlier "out for delivery" can flip a
   delivered order back to shipped (CLAUDE.md → "Same-day status
   ordering"). Mutates `working` in place.
   deps = { fetchFull } — injectable for offline tests. */
export async function applyStatusEmails(statusEmails, token, working, run, deps = {}) {
  const { fetchFull = getMessageFull } = deps;
  for (const em of statusEmails) {
    let oid = em.orderId;
    let html = null;
    let tracking = null;
    let matchedByTracking = false;
    // Fetch the body when the PO isn't in the subject (to find it), and
    // for shipped emails regardless — they carry the estimated-arrival
    // window and the carrier tracking link. Cheap regex, no Claude call.
    if (!oid || em.kind === "shipped") {
      try {
        const fullMsg = await fetchFull(em.id, token);
        html = extractHtml(fullMsg.payload);
        // parent_order_sn in the tracking link is exact — the first-PO-
        // in-raw-HTML approach could grab a SIBLING order's number.
        if (!oid) oid = extractPoFromBody(html);
        tracking = extractTracking(html);
        // Some status emails never mention the PO anywhere at all — e.g.
        // Temu's forwarded "UPS My Choice" delivery notifications. They DO
        // carry the carrier tracking number as plain text, and that same
        // number was already recorded on the order by its earlier "shipped"
        // email — so fall back to matching by tracking number.
        if (!oid && tracking?.number) {
          const byTracking = working.orders.find((o) => o.tracking?.number === tracking.number);
          if (byTracking) { oid = byTracking.id; matchedByTracking = true; }
        }
      } catch { /* skip */ }
    }
    const target = oid && working.orders.find((o) => o.id === oid);
    if (target) {
      const prevStatus = target.status || "ordered";
      target.status = em.kind;
      // The EMAIL's own date, not run time — see CLAUDE.md "Recently
      // delivered" for why statusEmailAt and updatedAt are different signals.
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
      run.mutations++;
      run.statusApplied++;
      // Push only on a REAL transition — two emails that both bucket as
      // "shipped" (e.g. shipped + out-for-delivery) must not double-notify.
      if (prevStatus !== em.kind) {
        run.statusChanges.push({ id: target.id, kind: em.kind, item: target.items?.[0]?.name || null });
      }
      if (!working.processedIds.includes(em.id)) working.processedIds.push(em.id);
      const beforeLen = working.unmatchedStatus.length;
      working.unmatchedStatus = working.unmatchedStatus.filter((x) => x.id !== em.id && x.oid !== oid);
      if (working.unmatchedStatus.length !== beforeLen) run.mutations++;
      console.log(`✓ ${oid} → ${em.kind}${matchedByTracking ? " (matched by tracking #, no PO in email)" : ""}${em.kind === "shipped" && target.eta ? ` (est. ${target.eta})` : ""}${em.kind === "shipped" && target.tracking?.carrier ? ` · ${target.tracking.carrier}` : ""}`);
    } else {
      // Deliberately NOT marked processed: if the order confirmation failed
      // to parse this run (or waits behind the vision budget), marking this
      // processed would strand the order at "ordered" forever. Recorded in
      // unmatchedStatus so the app's Review queue can show it (the app's
      // Reconcile remains the canonical recovery path — these emails stay
      // findable there because they're not in processedIds).
      run.statusUnmatched++;
      if (!working.unmatchedStatus.some((x) => x.id === em.id)) {
        working.unmatchedStatus.push({ id: em.id, oid: oid || null, kind: em.kind, date: em.date, trackingNumber: tracking?.number || null });
        run.mutations++;
      }
      console.warn(`✗ ${em.kind} email has no matching order${oid ? ` (${oid})` : tracking?.number ? ` (no PO, tracking ${tracking.number} matches no stored order)` : " (no PO found in it)"}.`);
    }
  }
}

/* ---------------- push message building ---------------- */

/* Grouping per the notification design: one message for all new orders,
   one per real status transition. Exported for the offline test. */
export function buildPushMessages(run) {
  const messages = [];
  if (run.newOrders.length) {
    const total = run.newOrders.reduce((s, o) => s + (o.total || 0), 0);
    messages.push({
      title: "New Temu orders",
      body: `${run.newOrders.length} new order${run.newOrders.length === 1 ? "" : "s"} parsed (total ${fmt(total)})`,
      tag: "temu-new-orders",
      url: APP_URL,
    });
  }
  for (const ch of run.statusChanges) {
    messages.push({
      title: `Order ${ch.kind}`,
      body: `${ch.id} ${ch.kind}${ch.item ? ` — ${ch.item}` : ""}`,
      tag: `temu-status-${ch.id}`,
      url: APP_URL,
    });
  }
  return messages;
}

/* ---------------- main ---------------- */

async function main() {
  const DB_URL = process.env.FIREBASE_DATABASE_URL;
  const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
  const SYNC_UID = process.env.SYNC_UID;
  const missing = [
    !DB_URL && "FIREBASE_DATABASE_URL",
    !SA_JSON && "FIREBASE_SERVICE_ACCOUNT",
    !process.env.GMAIL_CLIENT_ID && "GMAIL_CLIENT_ID",
    !process.env.GMAIL_CLIENT_SECRET && "GMAIL_CLIENT_SECRET",
    !process.env.GMAIL_REFRESH_TOKEN && "GMAIL_REFRESH_TOKEN",
    !SYNC_UID && "SYNC_UID",
    !process.env.ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")} — see docs/background-sync-setup.md.`);
    process.exit(1);
  }

  // Dynamic import: firebase-admin is installed by the workflow at run time
  // (npm install --no-save, same as carrier-eta.yml) and isn't needed by the
  // exported pipeline functions, so the offline test can import this module
  // without it.
  const { default: admin } = await import("firebase-admin");
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(SA_JSON)),
    databaseURL: DB_URL,
  });
  const db = admin.database();

  console.log(`Gmail sync for uid ${SYNC_UID} (vision budget ${MAX_VISION_PER_RUN}/run)…`);
  const token = await refreshGmailToken();
  console.log("Gmail access token refreshed.");

  /* Read the current cloud state. No state yet is fine — first run behaves
     like the app's first sync (full 5y window), just budget-throttled: it
     catches up MAX_VISION_PER_RUN orders per run until done. */
  const stateSnap = await db.ref(`manifest/${SYNC_UID}/state`).get();
  let base = null;
  if (stateSnap.exists()) {
    try { base = JSON.parse(stateSnap.val()?.json || "null"); }
    catch (e) {
      // A corrupt blob is a config-level disaster — refuse to plough a fresh
      // 5y re-parse over it. Daily backups exist under manifest/{uid}/backups.
      console.error(`Cloud state at manifest/${SYNC_UID}/state exists but won't parse (${e.message}) — refusing to overwrite. Restore a backup first.`);
      process.exit(1);
    }
  }
  if (!base) {
    console.log("No cloud state yet — starting from an empty store (first run parses history in budget-sized chunks).");
    base = { orders: [], processedIds: [], ratings: {}, lastSync: null, autoSync: true };
  }
  const working = {
    ...base,
    orders: [...(base.orders || [])],
    processedIds: [...(base.processedIds || [])],
    // Same row shape the app keeps in its unmatchedStatus React state
    // ({id, oid, kind, date, trackingNumber}), persisted here so headless
    // findings survive the run.
    unmatchedStatus: [...(base.unmatchedStatus || [])],
  };
  const run = newRunCounters();

  /* 1 — find Temu emails since lastSync (same queries/windowing as the app's
     incremental sync — see src/App.jsx sync() step 1). */
  const sinceClause = working.lastSync
    ? ` after:${new Date(working.lastSync).toISOString().slice(0, 10).replace(/-/g, "/")}`
    : " newer_than:5y";
  const orderQuery = `from:transaction.temu.com subject:("order confirmation" OR "orders confirmation")${sinceClause}`;
  const statusQuery = `from:transaction.temu.com subject:(delivered OR arrived OR shipped OR delivery OR "transferred to" OR cancel OR cancelled OR canceled OR refund OR return OR returned)${sinceClause}`;

  const [orderMsgs, statusMsgs] = await Promise.all([
    searchMessages(orderQuery, token),
    searchMessages(statusQuery, token),
  ]);

  /* Metadata pass: subject (kind + PO) and date. `at` keeps full timestamp
     precision for sorting; `date` stays day-only for storage/display. */
  const emails = [];
  for (const m of [...orderMsgs.map((x) => ({ ...x, isOrder: true })), ...statusMsgs.map((x) => ({ ...x, isOrder: false }))]) {
    try {
      const meta = await getMessageMetadata(m.id, token);
      const subject = headerValue(meta, "Subject");
      const hdr = headerValue(meta, "Date");
      emails.push({
        id: m.id,
        kind: m.isOrder ? "order" : classifyStatusSubject(subject),
        at: hdr ? new Date(hdr).toISOString() : null,
        date: hdr ? new Date(hdr).toISOString().slice(0, 10) : null,
        orderId: extractPoNumber(subject),
      });
    } catch (e) {
      console.warn(`metadata fetch failed for ${m.id.slice(0, 10)}… (${e.message}) — skipped this run.`);
    }
  }
  console.log(`Found ${emails.filter((e) => e.kind === "order").length} order confirmation(s), ${emails.length} Temu email(s) total in window.`);

  /* 2 — process order confirmations. Same selection as the app: check the
     actual orders array (hasOrder), not processedIds, so app-side deletions
     recover; re-try stored orders that parsed with 0 items; and check EVERY
     sibling of a split email's messageId for emptiness. */
  const hasOrder = (id) => working.orders.some((o) => o.messageId === id);
  const isEmptyOrder = (id) => working.orders.some((o) => o.messageId === id && (!o.items || o.items.length === 0));
  const searchOrderIds = new Set(emails.filter((e) => e.kind === "order").map((e) => e.id));
  const retries = working.orders
    .filter((o) => (!o.items || o.items.length === 0) && o.messageId && !searchOrderIds.has(o.messageId))
    .map((o) => ({ id: o.messageId, kind: "order", orderId: o.id, date: o.date }));
  // Oldest-first: order-confirmation emails get read before their
  // shipped/delivered/cancelled follow-ups, and if a run is budget-cut
  // partway the earliest orders are the ones that land.
  const newOrderEmails = [
    ...emails.filter((e) => e.kind === "order" && (!hasOrder(e.id) || isEmptyOrder(e.id))),
    ...retries,
  ].sort((a, b) => (a.at || a.date || "").localeCompare(b.at || b.date || ""));
  if (retries.length) console.log(`Retrying ${retries.length} previously-empty order(s).`);

  let budgetSkipped = 0;
  for (let i = 0; i < newOrderEmails.length; i++) {
    if (run.budgetTruncated) { budgetSkipped++; continue; }
    console.log(`Reading order email ${i + 1}/${newOrderEmails.length}…`);
    const res = await processOrderEmail(newOrderEmails[i], token, working, run);
    if (res === "budget") budgetSkipped++;
  }
  if (budgetSkipped) console.log(`Vision budget reached — ${budgetSkipped} order email(s) left for the next run (lastSync held back so they stay in the window).`);

  /* 3 — status updates: shipped / delivered / cancelled / returned.
     Skip processed, oldest-first by full timestamp. */
  const statusEmails = emails
    .filter((e) => e.kind !== "order" && !working.processedIds.includes(e.id))
    .sort((a, b) => (a.at || a.date || "").localeCompare(b.at || b.date || ""));
  await applyStatusEmails(statusEmails, token, working, run);
  if (run.statusApplied || run.statusUnmatched) {
    console.log(`Status pass: ${run.statusApplied} applied, ${run.statusUnmatched} unmatched.`);
  }

  /* 4 — write back, but only if something actually changed. */
  if (run.mutations === 0) {
    console.log("Nothing new — no write, no pushes. Done.");
    process.exit(0);
  }

  // Only advance lastSync on a COMPLETE pass over the window: a budget cut
  // or a failed order email means emails in this window still need work, and
  // advancing lastSync past them would orphan them (the headless analogue of
  // the app's cancelled-sync rule — there's no human here to hit Retry).
  if (!run.budgetTruncated && run.orderFails === 0) {
    working.lastSync = new Date().toISOString();
  } else {
    console.log("lastSync NOT advanced (budget cut or failed email) — next run re-scans the same window.");
  }
  working.updatedAt = Date.now();

  /* This Action is "another device" in the per-order merge model: a phone
     could have saved mid-run, so RE-FETCH the cloud state and merge our
     result over it before writing. mergeState keeps, per order, whichever
     copy has the newer per-order updatedAt, and unions processedIds — a
     mid-run save to an order we didn't touch always survives. */
  let remoteNow = null;
  try {
    const snap2 = await db.ref(`manifest/${SYNC_UID}/state`).get();
    if (snap2.exists()) remoteNow = JSON.parse(snap2.val()?.json || "null");
  } catch (e) {
    console.warn(`Pre-write re-fetch failed (${e.message}) — merging against the start-of-run state only.`);
  }
  const merged = remoteNow ? mergeState(working, remoteNow) : working;
  await db.ref(`manifest/${SYNC_UID}/state`).set({ json: JSON.stringify(merged), updatedAt: merged.updatedAt });
  console.log(`State written (${merged.orders.length} orders, ${merged.processedIds.length} processed ids).`);

  /* 5 — push notifications for what changed THIS run. Data-only FCM —
     see scripts/push.mjs for the payload contract. */
  const messages = buildPushMessages(run);
  if (messages.length) {
    const r = await sendPushes(admin, db, SYNC_UID, messages);
    console.log(`Push: ${messages.length} message(s) → ${r.sent} sent${r.failed ? `, ${r.failed} failed` : ""}${r.pruned ? `, ${r.pruned} dead token(s) pruned` : ""}.`);
  }

  console.log(`Done: ${run.newOrders.length} new order(s), ${run.statusApplied} status update(s) (${run.statusChanges.length} transition(s)), ${run.statusUnmatched} unmatched, ${run.visionCalls} vision call(s).`);
  process.exit(0);
}

// Run main() only when executed directly (node scripts/gmail-sync.mjs) —
// importing this module (offline tests) must not touch the network or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
