# Improvements & Issues Tracker

Produced 2026-07-10 from a multi-agent review of the Temu Order Manifest codebase:
independent UI/UX, architecture, and data/sync reviews were run in parallel, then
synthesized here into one deduplicated, re-ranked list. Each issue has a stable ID
(`IMP-###`) for future reference — keep IDs stable across edits to this file, and
flip `Status` to `Fixed`/`Wontfix`/`In progress` as work lands rather than deleting
rows, so this stays a durable log.

## Executive summary

The app is in solid shape for a personal single-user tool: the per-order cloud
merge, split-order handling, and review-queue machinery are all thoughtfully
built and (mostly) do what CLAUDE.md says they do. But this review surfaced four
**P0** issues, and three of them are data-integrity bugs, not polish — the most
serious is that `sync()`'s local snapshot is built *before* `connectCloud()`'s
merge resolves, so the very first "Check Gmail" of a browser session can revert
another device's changes locally and then **push that regression to Firebase**,
silently propagating stale data to every device. A close second is that "Full
re-sync" — one plain-text link with no confirmation — wipes every hand-edited
order and re-runs a vision call per order in Gmail history, while much smaller
actions nearby (Clear all data, Re-read) already get warnings; the risk/warning
pairing is inverted. A third silently produces confident-looking $0.00 prices for
a subset of split orders instead of flagging them for review, which quietly
undercounts spend with no visible symptom. Beyond these, there's a real but
lower-frequency class of "lost edit" races (stale React closures, whole-order
merge granularity, no server-clock guard) that matter more as multi-device usage
continues, plus a genuinely mis-scoped "accepted limitation" — deletion
resurrection across devices, which the architecture review found to be the
deterministic outcome of normal offline-then-reconnect usage, not a rare edge
case, and which now has a concrete, compatible tombstone fix. The UI/UX findings
are mostly non-destructive (mobile parity gaps, accessibility, staleness in
popups) and cheap to fix. The biggest opportunities are structural: extracting
the ~500-line Gmail sync engine out of `App.jsx` into its own module, moving
`save()` to a functional-update pattern to close the lost-edit race class at the
root, giving items stable IDs instead of array-index addressing, and — longer
term — replacing the single ever-growing JSON blob with per-order RTDB paths.
None of this requires a rewrite; the codebase's own patterns (the Lightbox
Escape-key handler, `OrderSheet`'s live re-derivation, the per-order `updatedAt`
mechanism) are already the right template for fixing most of what's broken
elsewhere.

---

## P0 — Critical

### IMP-001 — "Full re-sync" wipes every manual edit with zero warning
**Priority:** P0 · **Status:** Fixed
> Fixed 2026-07-10 — strong confirm() naming the manual-edit wipe + vision-call cost, plus a title tooltip; points user to Reconcile as the safe option.
Clicking "Full re-sync" empties `orders`/`processedIds` before re-reading Gmail from scratch, so the manual-edit guard in `saveOrder` never fires (there's no `old` order left to protect) — every hand-corrected name, price, category, or status is gone, permanently, with no undo. The button itself has no `confirm()` and no explanatory text, unlike the much less consequential "Clear all data" (which does confirm) and "Re-read" (which confirms and names the risk explicitly). This directly contradicts CLAUDE.md's documented invariant that manual edits are never overwritten by sync.
**Affected files:** `src/App.jsx` (~lines 802-809), `src/components/SettingsPanel.jsx` (~lines 25-32)
**Source:** UI/UX review
**Fix risk:** LOW · **Effort:** S

### IMP-002 — `sync()`'s local snapshot never sees `connectCloud()`'s merge — first sync of a session can overwrite cloud data
**Priority:** P0 · **Status:** Fixed
> Fixed 2026-07-10 — connectCloud is now a shared awaitable promise; sync() awaits it and builds `working` from dataRef.current (post-merge). Verified by build + trace.
`sync()` builds its working copy from the `data` closure and fires `connectCloud(token)` without awaiting it; `connectCloud`'s first pull does an unguarded `setData(merged)`, but every later `save()` call in the sync loop re-stamps and unconditionally pushes the *original*, merge-unaware `working` snapshot — including to Firebase. Given the ~1-hour token cache and "Check Gmail" being the app's primary action, this isn't a rare race: it's close to the normal pattern for a 2-device household, and it can regress the shared cloud state for every device, not just this one.
**Affected files:** `src/App.jsx` (sync ~lines 802-813, save ~lines 98-108, connectCloud ~lines 110-133)
**Source:** Data/sync review
**Fix risk:** LOW · **Effort:** S — reorder to `await connectCloud(token)` before constructing `working`, or rebuild `working` from `dataRef.current` right before the loop.

### IMP-003 — Mid-sync remote updates are silently dropped, not deferred as the log message claims
**Priority:** P0 · **Status:** Fixed
> Fixed 2026-07-10 — listener parks the payload in pendingRemoteRef; an effect replays it through the shared applyRemote() merge when syncing flips false.
When a remote change arrives while `syncingRef.current` is true, the live listener logs "will merge once this sync finishes" and returns — but no pending-merge flag or replay effect exists, so the update is simply discarded unless the other device happens to write again later. Combined with IMP-002, this means a remote edit landing mid-sync isn't just stale — this device's own subsequent `save()` calls can actively overwrite it before it's ever looked at.
**Affected files:** `src/App.jsx` (~lines 145-166)
**Source:** Data/sync review
**Fix risk:** LOW · **Effort:** S — set a `pendingRemoteMergeRef` flag and re-run the merge-pull when `syncing` flips back to `false`.

### IMP-004 — Split-order sub-order total mismatch silently produces a confident $0.00, not a flagged estimate
**Priority:** P0 · **Status:** Fixed
> Fixed 2026-07-10 — new `base <= 0` catch-all branch in applyDiscounts prices items as null and flags `estimated`, routing them into Needs Review / Try real prices instead of a silent $0.00.
`extractSubOrders` pairs sub-order IDs to per-order totals by array position; if the regex finds fewer "Order total" lines than "Order ID" lines, a later sub-order gets `total: null`. That null total causes `applyDiscounts`'s estimate-fallback branch (which normally flags items `estimated`/`listedUnknown`) to be skipped, because it only triggers when `netMerch > 0` — with a null total, `netMerch` computes to `0`, so the generic proportional-discount path runs instead and produces `paid: 0.00`, `discountPct: 0%`, with **no review flag at all**. This is worse than the already-documented "sub-order never created" failure (CLAUDE.md open thread #1) because here the order *is* created, looking fully-priced and confirmed-free, and it quietly undercounts spend/analytics with nothing surfacing in Needs Review.
**Affected files:** `src/lib/gmail.js` (`extractSubOrders`, ~lines 129-135), `src/lib/discounts.js` (`applyDiscounts`)
**Source:** Architecture review
**Fix risk:** LOW · **Effort:** S — broaden the guard to `if (base <= 0 && (netMerch > 0 || order.total == null))` so a null total routes through the same even-split-and-flag path as a known total.

---

## P1 — Important

### IMP-005 — Every mutation reads a stale React-render closure, not a functional update — concurrent edits can silently drop one another
**Priority:** P1 · **Status:** Fixed
> Fixed 2026-07-10 — save() (and connectCloud/applyRemote) write dataRef.current synchronously; every mutation site (saveEdit, updateItem, deleteOrder, openOrderPage, fixEstimatedPrices, carrier-promote, all working-snapshot builders) now reads dataRef.current instead of the render closure. Same effect as the functional-update pattern.
`saveEdit`, `updateItem`, `deleteOrder`, `fixEstimatedPrices`, and the carrier auto-promote effect all read `data` from whatever the current render closure captured, then call `save()` with a precomputed object (`save()` itself just does `setData(stamped)`, not a functional update). If two of these fire in the same render tick — e.g. the carrier-promote effect running the same pass as a user's quick edit — the second call's stale `data` doesn't contain the first call's change, and it silently overwrites it locally, in IndexedDB, and on Firebase. No error, no log line — indistinguishable from "the edit didn't stick."
**Affected files:** `src/App.jsx` (save ~98-108, saveEdit ~289-322, updateItem ~325-348, deleteOrder ~350-353, fixEstimatedPrices ~738-755, carrier-promote effect ~191-201)
**Source:** Data/sync review
**Fix risk:** MEDIUM (mechanical, clear fix, but touches every mutation call site — needs extra care: verify with build + logic trace since this feeds the cloud-sync path and no tests exist) · **Effort:** M

### IMP-006 — Conflict resolution trusts each device's raw wall clock, with no server timestamp or skew guard
**Priority:** P1 · **Status:** Mitigated (partial)
> Mitigated 2026-07-10 — connectCloud now measures skew via Firebase `.info/serverTimeOffset` and logs a warning above 2 min. Full server-time stamping remains open.
Every per-order `updatedAt` is stamped with plain `Date.now()`, and `mergeOrders` picks the winner purely by comparing these client-supplied numbers. A device with a skewed clock (wrong timezone, bad RTC battery, manual clock change, DST bug) will have every one of its edits out-rank genuinely later edits from a correctly-clocked device, permanently, until the skew is fixed — a slow-motion version of IMP-002 triggered by something as mundane as a phone's clock being wrong.
**Affected files:** `src/App.jsx` (all `Date.now()` stamps), `src/lib/syncMerge.js` (`mergeOrders`, ~lines 35-43)
**Source:** Data/sync review
**Fix risk:** MEDIUM for full fix (Firebase `.info/serverTimeOffset` correction); LOW for a partial mitigation (warn when a merged timestamp looks implausibly far ahead) · **Effort:** S (partial) / M (full)

### IMP-007 — Local persistence failure is caught but only logged — in-memory state can silently diverge from what's actually saved
**Priority:** P1 · **Status:** Mostly fixed
> Mostly fixed 2026-07-10 — both storage backends now individually guarded; a double failure throws a clear "NOT saved locally" error that save() logs. Persistent banner (vs log line) still open.
`storage.set`'s `localStorage` fallback has no try/catch of its own, so if IndexedDB fails (quota, private mode) **and** localStorage also throws, the exception propagates. The only catch is in `App.jsx`'s `save()`, which already ran `setData(stamped)` *before* attempting the write — so in-memory state moves on regardless of whether persistence succeeded, with the only symptom being one line in a 400-line log ring buffer. On reload, the app silently rolls back to the last successfully persisted snapshot, discarding every edit since the first failure, with no user-facing warning.
**Affected files:** `src/lib/storage.js` (~lines 92-100), `src/App.jsx` (`save`, ~lines 98-108)
**Source:** Data/sync review
**Fix risk:** LOW · **Effort:** S — wrap the localStorage fallback in its own try/catch, and surface a persistent dismissable banner (not just a log line) the moment any save fails.

### IMP-008 — Cross-device deletion resurrection is the deterministic norm for offline devices, not a rare race — and a compatible tombstone fix now exists
**Priority:** P1 · **Status:** Open
CLAUDE.md documents this as an accepted, narrow limitation requiring the second device to save something before pulling a deletion. Tracing the code shows that's not required: the live listener itself merges and re-pushes on *every* remote value it receives, with no local save needed — so the actual trigger is simply "device B still has its local copy of the deleted order the next time it receives any cloud update," which is true for any device that was closed/offline at the moment of deletion (the normal case for a phone + desktop household). This upgrades the documented limitation: a tombstone map (`deletedOrders: {orderId: deletedAt}`, merged like `processedIds` but keeping the max timestamp, with `mergeOrders` dropping any order whose tombstone is newer than its `updatedAt`) is compatible with the existing "delete to force a clean Reconcile re-read" mechanism, because a Reconcile-recreated order gets a fresh `updatedAt` that's newer than the old tombstone by construction.
**Affected files:** `src/lib/syncMerge.js` (`mergeOrders`), `src/App.jsx` (`deleteOrder` ~350-353, `cloudSubscribe` ~145-166)
**Source:** Architecture review (reframes/upgrades a CLAUDE.md-accepted limitation with a concrete compatible fix — not a contradiction, an improvement on the documented status quo)
**Fix risk:** MEDIUM (touches the sync-correctness core; deserves the same care as the original per-order-`updatedAt` migration — needs extra care: verify with build + logic trace, no tests exist) · **Effort:** M

### IMP-009 — `importData` wholesale-replaces orders with no merge and no destructive-action warning
**Priority:** P1 · **Status:** Fixed
> Fixed 2026-07-10 — confirmation dialog added in SettingsPanel naming the wholesale replace and cloud push. Merge-on-import still open as a future upgrade.
Importing a JSON backup directly replaces `orders`/`processedIds` rather than merging with current `data`, and (since `save()` pushes unconditionally, per IMP-002) immediately regresses the shared cloud state for every device if an old backup is imported "just to look something up," with no confirmation dialog naming the consequence.
**Affected files:** `src/App.jsx` (~lines 256-276)
**Source:** Data/sync review
**Fix risk:** LOW (confirmation-dialog version) / MEDIUM (full `mergeState` integration) · **Effort:** S (dialog) / M (merge integration)

---

## P2 — Worthwhile

### IMP-010 — `estimated` and `listedUnknown` are not actually mutually exclusive, contra the documented data model
**Priority:** P2 · **Status:** Fixed
> Fixed 2026-07-10 — `it.listedUnknown = singleItem` in the fallback branch; flags are now genuinely exclusive.
CLAUDE.md states the two flags are mutually exclusive, but the multi-item split-order fallback in `discounts.js` sets `listedUnknown = true` unconditionally alongside `estimated = !singleItem`, so a fully-estimated multi-item row gets both flags. Every render site defensively guards against double-badging, but `itemSearchIndex` doesn't, so searching "list price unknown" incorrectly also surfaces genuinely-estimated items.
**Affected files:** `src/lib/discounts.js` (~lines 35-42), `src/lib/derive.js` (`itemSearchIndex`, ~lines 93-98)
**Source:** Architecture review
**Fix risk:** LOW · **Effort:** S — `it.listedUnknown = singleItem;` mirroring `it.estimated`.

### IMP-011 — `isEmptyOrder` only inspects one sibling of a split-order email, so a partially-empty split order won't self-heal on a normal sync
**Priority:** P2 · **Status:** Fixed
> Fixed 2026-07-10 — isEmptyOrder now checks every order sharing the messageId via .some().
When a split-order email produces several orders sharing one `messageId`, `isEmptyOrder` only checks whichever sibling `Array.find` hits first. If that one parsed fine but another sibling parsed with 0 items, the empty one is silently skipped on normal syncs (not `wide` Reconcile) until an explicit Reconcile. Soft impact — the empty order still surfaces in Needs Review, which links to Reconcile — but it defeats the "Check Gmail" auto-retry the function's own comment promises.
**Affected files:** `src/App.jsx` (~lines 882-904)
**Source:** Architecture review
**Fix risk:** LOW · **Effort:** S — check `working.orders.some(...)` across all orders sharing the messageId, not just `.find()`'s first hit.

### IMP-012 — `ItemSheet` shows a frozen snapshot — "Try real prices" doesn't visibly update its own popup
**Priority:** P2 · **Status:** Fixed
> Fixed 2026-07-10 — went with the full fix: ItemSheet re-derives the live item from c.data each render (OrderSheet's pattern), so "Try real prices" updates the open sheet in place.
Unlike `OrderSheet`, which re-derives its subject from `c.data` on every render, `ItemSheet` receives a plain object prop captured at open time and never re-looks it up. Its own quick-edit and re-read actions happen to call `onClose()` after saving, masking the issue, but `fixEstimatedPrices`'s button does not — so after a successful "Try real prices" fix, the open sheet keeps showing the stale badge/price/status until closed and reopened. Confusing but not destructive; underlying `data.orders` is correct.
**Affected files:** `src/components/ItemSheet.jsx` (~lines 174-188), `src/components/OrderSheet.jsx` (~line 23, as the pattern to copy)
**Source:** Architecture review
**Fix risk:** LOW (quick patch: call `onClose()` from the fix-prices button too) / MEDIUM (full fix: re-derive `it` from `c.data`/`itemIdx` each render, touching both shells' call sites) · **Effort:** S (quick) / M (full)

### IMP-013 — Merge granularity is whole-order, not per-field — concurrent edits to different fields of the same order still fully clobber each other
**Priority:** P2 · **Status:** Open
`mergeOrders` keeps one side's entire order object per id. If Device A's Reconcile status-pass updates `status`/`tracking`/`eta` on an order while Device B independently corrects an item price on the same order, whichever `updatedAt` is larger wins *in its entirety* — the other device's unrelated edit to a different part of the same order is silently discarded, not combined. Distinct from the documented deletion-tombstone gap; this applies to live, non-deleted orders.
**Affected files:** `src/lib/syncMerge.js` (`mergeOrders`, ~lines 35-43)
**Source:** Data/sync review
**Fix risk:** MEDIUM (real design work — deciding a field-ownership scheme) · **Effort:** M-L

### IMP-014 — Items are addressed by array index, not a stable id — a concurrent items-array replacement can silently misalign an edit onto the wrong item
**Priority:** P2 · **Status:** Open
`updateItem(orderId, itemIdx, patch)` and related code address items purely by position; several operations (re-read, `fixEstimatedPrices`, a cloud merge picking a newer whole-order copy) replace the entire `items` array. If one of these lands between a user opening an item's edit sheet (capturing `itemIdx`) and submitting the edit, the edit silently applies to whatever now occupies that index — a different item, with no integrity check.
**Affected files:** `src/App.jsx` (`updateItem` ~325-348), `src/lib/derive.js` (`allItems`/`reviewQueue`)
**Source:** Data/sync review
**Fix risk:** MEDIUM (schema change + migration for existing orders lacking an id, fallback to index) · **Effort:** M

### IMP-015 — `carrier-eta.mjs`: a throwing adapter aborts the whole fallback chain for that tracking number
**Priority:** P2 · **Status:** Fixed
> Fixed 2026-07-10 — each adapter call wrapped in its own attempt() try/catch; a throwing adapter logs and falls through to the next.
The comment describes "first adapter that produces a record wins," but all adapter calls share one `try` block, and adapters throw (not return `null`) on a non-2xx response — so the first adapter that throws aborts the entire chain instead of falling through to the next. Low impact today (Shippo is the only configured adapter), but it silently defeats the documented multi-adapter design the moment a second provider (e.g. EasyPost as a backup) is re-enabled, and even today a transient Shippo error drops that number's refresh for the whole 6-hour cycle.
**Affected files:** `scripts/carrier-eta.mjs` (~lines 349-364)
**Source:** Architecture review
**Fix risk:** LOW · **Effort:** S — wrap each adapter attempt in its own try/catch (or a `tryAdapter(fn)` helper returning `null` on error).

### IMP-016 — No automated backup beyond a manual JSON/CSV export
**Priority:** P2 · **Status:** Fixed
> Fixed 2026-07-10 — carrier-eta.mjs now snapshots the state blob to manifest/{uid}/backups/{YYYY-MM-DD} once per day (7-day retention). Restore = copy a backup's json over state in the Firebase console.
`exportData`/`importData` are the entire backup story; there's no scheduled snapshot, and `carrier-eta.mjs` never touches the `state` node. If local storage is cleared/corrupted on both devices and the Firebase `state` node is also lost or regressed (e.g. by IMP-002 or IMP-009) with no recent manual export, the order history is unrecoverable.
**Affected files:** `scripts/carrier-eta.mjs`, `.github/workflows/carrier-eta.yml`
**Source:** Data/sync review
**Fix risk:** LOW (additive, isolated from live read/write paths) · **Effort:** S — extend the existing 6-hourly GitHub Action (already has RTDB admin creds) to copy `manifest/{uid}/state` to a dated backup path on each run.

### IMP-017 — Explanatory `title` tooltips never surface on the touch-first mobile shell
**Priority:** P2 · **Status:** Open
Nearly all inline guidance is delivered via `title`, which requires hover and is unreliable-to-absent on touch: the only explanation distinguishing "Reconcile" from "Full re-sync," the price-fix button's entire explanation of its vision-call cost, and `CropThumb`'s "Tap to view" hint are all hover-only. Mobile is one of the app's two primary shells and its users get materially less context for destructive/costly actions than desktop users.
**Affected files:** `src/components/SettingsPanel.jsx` (~line 25), `src/components/ItemSheet.jsx` (~lines 176-179), `src/components/shared.jsx` (`CropThumb`, ~line 96)
**Source:** UI/UX review
**Fix risk:** MEDIUM (touches shared components used by both shells) · **Effort:** M

### IMP-018 — Detail sheets have no Escape-to-close, focus trap, or dialog semantics
**Priority:** P2 · **Status:** Fixed
> Fixed 2026-07-10 — Escape-to-close (deferring to a stacked Lightbox) + role="dialog"/aria-modal/aria-label on both sheets. Focus trap still open.
`ItemSheet`/`OrderSheet` close only via backdrop click or an explicit button — no `role="dialog"`/`aria-modal`, no focus management, no Escape handler — even though the exact pattern needed already exists in the same file for `Lightbox` (a `keydown` listener that closes on Escape). The far more frequently opened item/order sheets don't get this treatment.
**Affected files:** `src/components/ItemSheet.jsx`, `src/components/OrderSheet.jsx`, `src/App.jsx` (Lightbox pattern to copy, ~lines 74-80)
**Source:** UI/UX review
**Fix risk:** LOW · **Effort:** S — reuse the existing Escape-key pattern; add `role="dialog"`/`aria-modal="true"`.

### IMP-019 — Order deletion and the full-order edit form exist only on desktop
**Priority:** P2 · **Status:** Open
`deleteOrder`, `startEdit`/`editDraft`/`saveEdit`, and `EditForm` are only wired up in `DesktopShell.jsx`. Mobile's only edit surface is `ItemSheet`'s single-item quick edit; there's no way on mobile to delete an order or correct order-level fields (status, subtotal, discount, shipping, tax) — a phone-only user has to switch devices for two of the app's own documented debugging flows.
**Affected files:** `src/components/DesktopShell.jsx` (~lines 458-463, 538-628), `src/components/MobileShell.jsx`
**Source:** UI/UX review
**Fix risk:** MEDIUM-HIGH (needs new mobile UI, not just wiring existing handlers) · **Effort:** L

### IMP-020 — Manual edit form can remove items but has no way to add one
**Priority:** P2 · **Status:** Fixed
> Fixed 2026-07-10 — "+ Add item" button appends a blank row to editDraft.items.
`EditForm` has a per-row remove button but no "add item" control, so if Claude vision undercounts a receipt, the only recovery is Re-read (which may reproduce the same miss, or wipe other hand-edits per IMP-001's mechanism) or manually editing exported JSON.
**Affected files:** `src/components/DesktopShell.jsx` (`EditForm`, ~lines 538-628)
**Source:** UI/UX review
**Fix risk:** LOW · **Effort:** S — add a "+ Add item" button appending a blank item row to `editDraft.items`.

### IMP-021 — `EditForm`'s Save button isn't disabled during sync, unlike the item quick-edit
**Priority:** P2 · **Status:** Fixed
> Fixed 2026-07-10 — Save disabled while syncing, with the same caption ItemSheet uses.
`saveEdit` silently no-ops while `syncing` is true (only a log line), and `ItemSheet`'s Save button already reflects this (`disabled={c.syncing}` + a visible caption), but `EditForm`'s Save button has no such guard — a click during an in-flight sync appears to do nothing, with no visible indication the button is inert. Thematically related to IMP-005: a user could reasonably believe their edit saved when it silently didn't.
**Affected files:** `src/components/DesktopShell.jsx` (`EditForm` Save button, ~lines 617-620)
**Source:** UI/UX review
**Fix risk:** LOW · **Effort:** S — add `disabled={c.syncing}` and the matching caption used in `ItemSheet`.

### IMP-022 — "Clear all data" doesn't disclose it also overwrites the Firebase copy
**Priority:** P2 · **Status:** Fixed
> Fixed 2026-07-10 — confirm text now names the Firebase push and suggests Export JSON first.
`c.save()` always pushes to Firebase when cloud is connected, with no distinction for a full wipe, so "Clear all data" immediately pushes an empty state to every synced device — but the confirm text ("Clear all stored orders?") reads as local-only and doesn't mention cloud sync at all.
**Affected files:** `src/components/SettingsPanel.jsx` (~lines 33-37)
**Source:** UI/UX review
**Fix risk:** LOW · **Effort:** S — reword the confirm to name the cloud push explicitly.

---

## P3 — Polish

### IMP-023 — Primary list rows are click-only `<div>`/`<tr>` elements, not reachable by keyboard or screen reader
**Priority:** P3 · **Status:** Open
The main way to open an item or order (clicking the row) has no `role`, `tabIndex`, or `onKeyDown` across both shells' tables and cards — a keyboard-only or screen-reader user cannot browse items/orders at all. Downgraded from the UI/UX review's HIGH given this is a single-user personal tool with no reported accessibility need today, but worth fixing if usage patterns change.
**Affected files:** `src/components/DesktopShell.jsx` (multiple `<tr onClick>` sites), `src/components/MobileShell.jsx` (`ItemCard`, order card header)
**Source:** UI/UX review
**Fix risk:** MEDIUM (mechanical, spread across many rows) · **Effort:** M

### IMP-024 — Sync/error log panel: inconsistent placement, no dismiss
**Priority:** P3 · **Status:** Open
Desktop renders `LogPanel` unconditionally above every view once any log lines exist, cluttering unrelated views like Analytics; mobile only shows it in Settings, so errors while browsing Items on a phone have no visible cue outside the review badge.
**Affected files:** `src/components/DesktopShell.jsx` (~line 199), `src/components/MobileShell.jsx` (~line 324), `src/components/shared.jsx` (`LogPanel`, ~lines 157-185)
**Source:** UI/UX review
**Fix risk:** LOW · **Effort:** S

### IMP-025 — Mobile "Open email" review-queue link is an unlabeled icon with no text
**Priority:** P3 · **Status:** Open
Desktop's `UnmatchedStatusRow` gives the Gmail deep-link visible text ("Open email"); mobile's equivalent drops the text entirely, leaving a bare 10px icon with no `aria-label`.
**Affected files:** `src/components/MobileShell.jsx` (~lines 404-407)
**Source:** UI/UX review
**Fix risk:** LOW · **Effort:** S

### IMP-026 — Mobile Items sort has no direction toggle (always forced descending)
**Priority:** P3 · **Status:** Open
Mobile's Items sort hardcodes descending order regardless of sort key, while mobile's own Orders sort and desktop's Items sort both support a direction toggle.
**Affected files:** `src/components/MobileShell.jsx` (~lines 89-93 vs. ~100-106)
**Source:** UI/UX review
**Fix risk:** LOW · **Effort:** S

### IMP-027 — `loaded` flag threaded into ctx but never consulted — brief "No orders yet" flash on every load
**Priority:** P3 · **Status:** Fixed
> Fixed 2026-07-10 — Empty takes a `loaded` prop (wired at all 5 call sites) and shows "Loading your orders…" until IndexedDB answers.
`App.jsx` sets `loaded` true only after IndexedDB resolves, but no shell checks it, so `Empty` renders for a fraction of a second before real data appears — reads as a data-loss scare, worse on slower devices.
**Affected files:** `src/App.jsx` (~lines 88-96, 1067), `src/components/shared.jsx` (`Empty`, ~lines 113-121)
**Source:** UI/UX review
**Fix risk:** LOW · **Effort:** S

### IMP-028 — Review-count badge gives no breakdown
**Priority:** P3 · **Status:** Open
The nav badge sums four different underlying problems (estimated items, empty orders, failed emails, unmatched status) into one number, so urgency/type can't be triaged from the nav alone.
**Affected files:** `src/components/DesktopShell.jsx` (~line 36), `src/components/MobileShell.jsx` (~line 354)
**Source:** UI/UX review
**Fix risk:** LOW · **Effort:** S

### IMP-029 — Widespread `stone-400` secondary text likely fails WCAG AA contrast
**Priority:** P3 · **Status:** Open
`text-stone-400` (~2.5:1 against white) is used pervasively for dates, item counts, and other genuinely information-bearing (not decorative) text across both shells, well under the 4.5:1 minimum.
**Affected files:** `src/components/DesktopShell.jsx`, `src/components/MobileShell.jsx` (multiple sites)
**Source:** UI/UX review
**Fix risk:** LOW · **Effort:** S

### IMP-030 — Global abort-controller singleton + dangling backup timer in `anthropic.js`
**Priority:** P3 · **Status:** Open
The `Promise.race` backup timeout is never cleared when the real fetch wins, firing harmlessly later; separately, `currentAbort` is a module-level singleton that would break cancellation if two Claude calls were ever in flight at once (not reachable today — every call site is serialized behind the `syncing` guard).
**Affected files:** `src/lib/anthropic.js` (~lines 29, 39-40, 56-61, 71-74)
**Source:** Architecture review
**Fix risk:** LOW · **Effort:** S

### IMP-031 — Dead code: unused `itemsCsvFromRows`, and CSV export ignores the active Items-view filter
**Priority:** P3 · **Status:** Open (re-scoped)
> Checked 2026-07-10 — itemsCsvFromRows is NOT dead (itemsCsv calls it internally); the real gap is that exports ignore the active filter. Left open, re-scoped.
`itemsCsvFromRows` was built "so the Items tab can export exactly what's currently filtered" but is never imported; the actual export handler always flattens every order's items, unfiltered.
**Affected files:** `src/lib/exportCsv.js` (~lines 34-60), `src/App.jsx` (~lines 247-250)
**Source:** Architecture review
**Fix risk:** LOW · **Effort:** S — either delete the unused function or wire it up to each shell's filtered rows.

### IMP-032 — `firebase.js` header comment describes the old whole-blob merge strategy, not the current per-order one
**Priority:** P3 · **Status:** Fixed
> Fixed 2026-07-10 — header comment now describes the per-order merge via lib/syncMerge.js.
The comment still says "newest-wins" whole-blob merge, predating the per-order merge in `syncMerge.js` — documentation drift only, but misleading to a future reader.
**Affected files:** `src/lib/firebase.js` (~lines 19-21)
**Source:** Architecture review
**Fix risk:** LOW · **Effort:** S

### IMP-033 — Duplicated logic between shells (`UnmatchedStatusRow`, related-orders chip, per-order `annotateThumbs` calls)
**Priority:** P3 · **Status:** Open
`UnmatchedStatusRow` is implemented twice nearly line-for-line; the "same email" chip row is duplicated across three sites; `annotateThumbs` is recomputed locally at multiple render sites instead of reusing `App.jsx`'s existing global memo. Maintainability risk only — a fix applied to one copy can silently drift from the other, as the code comments themselves ("mirrors DesktopShell's...") acknowledge is not supposed to happen.
**Affected files:** `src/components/DesktopShell.jsx` (~lines 824-866, 521-536, 473), `src/components/MobileShell.jsx` (~lines 370-411, 262-272, 247), `src/components/OrderSheet.jsx` (~lines 88-103, 85)
**Source:** Architecture review
**Fix risk:** LOW (mechanical extraction) · **Effort:** M

### IMP-034 — Equal-timestamp tie-break in `mergeOrders` silently favors whichever side is `local`
**Priority:** P3 · **Status:** Open
The comparison is strict greater-than and `local` seeds the map first, so an exact-millisecond tie always favors the local copy — realistic given the status-email loop can stamp several orders in the same tick. Deterministic but undocumented behavior.
**Affected files:** `src/lib/syncMerge.js` (~lines 35-43)
**Source:** Data/sync review
**Fix risk:** LOW · **Effort:** S — add a comment documenting the tie-break direction (or switch to `>=` deliberately, if ever preferred).

### IMP-035 — Floating-point currency arithmetic
**Priority:** P3 · **Status:** Open
Standard JS float math rounded per-operation to 2dp (not integer-cents accounting) can produce cent-level drift between a stored item sum and a separately-stored order total. Negligible in practice for this app's stakes; not worth re-architecting unless it becomes user-visible.
**Affected files:** `src/lib/discounts.js` (~lines 37, 50)
**Source:** Data/sync review
**Fix risk:** LOW (if ever touched) · **Effort:** S

### IMP-036 — Full-state JSON blob rewritten on every save — unbounded payload growth
**Priority:** P3 · **Status:** Open
Every `save()` serializes and pushes the *entire* state (all orders, images, the ever-growing `processedIds` array) even for a single item's price tweak — no partial/multi-path update. Over years of order history this only grows, widening the race windows described in IMP-002/IMP-005/IMP-006 and approaching RTDB's practical per-node payload guidance.
**Affected files:** `src/App.jsx` (`save`, ~lines 98-108), `src/lib/storage.js`, `src/lib/firebase.js` (~lines 100-103)
**Source:** Data/sync review
**Fix risk:** MEDIUM (real storage-shape migration; `processedIds` pruning alone is LOW) · **Effort:** L

### IMP-037 — Fully-free orders (coupon + credit = $0.00 total) priced items at full list price
**Priority:** P1 · **Status:** Fixed
> Fixed 2026-07-10 (evening) — found by Matt with a real order: a $29.99-list item fully covered by a $5 coupon + $5.92 account credit (order total $0.00, credit covering shipping and tax too). `applyDiscounts` computes `netMerch = total − shipping − tax` = −$3.11, and the old factor guard (`netMerch >= 0 ? … : 1`) treated any negative net as suspect data and bailed to factor 1 — pricing the free item as paid-full-list ($29.99) with 0% discount and inflating spend stats by the whole list amount. Fix: clamp instead of bail — `factor = min(max(netMerch, 0) / base, 1.5)` — so a covered order prices its items at $0.00 with −100% discount. Existing stored orders need a per-order ↺ Re-read (one vision call) to recompute.
**Affected files:** `src/lib/discounts.js` (factor computation)
**Source:** user report (post-deploy testing)
**Fix risk:** LOW · **Effort:** S

---

## Bigger ideas / future features

Ranked by value/effort, merging proposals from all three reviews:

1. **Extract the Gmail sync engine into its own module/hook** (`useGmailSync` or `lib/syncEngine.js`) — covers `processOrderEmail`, `sync`, `rereadOrder`, `importMissingOrder`, `fixEstimatedPrices`, `retryFailedEmails`, and the state they own. Removes ~500 of `App.jsx`'s 1091 lines with almost no coupling to untangle (needs only `data`/`save`/`pushLog` in, returns actions + two arrays out). Highest value/effort ratio identified across all three reviews. *(Architecture)*
2. **Move `save()` to a functional-update pattern** (`save(prev => next)` routed through `setData(prev => ...)`) across every mutation call site. This is the root-cause fix for IMP-005's whole "lost edit" class, and a prerequisite for doing IMP-013/IMP-014 safely. *(Data/sync)*
3. **Tombstoned trash bin instead of hard delete.** Directly resolves IMP-008, and as a side effect gives "Full re-sync," "Clear all data," and per-order delete a genuine undo window — addressing several P0/P1/P2 findings at once with one mechanism. *(UI/UX + Architecture)*
4. **Give items a stable id at parse time** (hash of name+thumbUrl+qty, or a generated id persisted from then on), addressed instead of array index. Prevents IMP-014's silent cross-item corruption and is a building block for field-level merge (#6 below). *(Data/sync)*
5. **A pre-flight cost/impact modal for expensive actions.** Full re-sync, Reconcile, and "Try real prices" all cost real vision-API calls against the user's own key; a shared confirmation modal naming the expected email/vision-call count folds in IMP-001's fix and turns every other silent-cost action into an informed choice. *(UI/UX)*
6. **Field-level (not whole-order) merge granularity**, building on stable item ids — status/tracking/eta vs. items/totals merged independently so concurrent edits to different parts of the same order stop clobbering each other (IMP-013). Real design work, worth doing after #2 and #4 land. *(Data/sync)*
7. **Move from one whole-state JSON blob to per-order RTDB paths** (`manifest/{uid}/orders/{orderId}`), so writes are incremental and the payload-growth/race-window problem (IMP-036) shrinks structurally instead of being patched around. Requires a migration path for existing single-blob data — higher effort, high long-term value. *(Data/sync)*
8. **Scheduled cloud→backup snapshot**, piggybacking on the existing carrier-eta GitHub Action's RTDB admin credentials (IMP-016) — cheap, isolated, real disaster-recovery value. *(Data/sync)*
9. **Consolidate shell-duplicated components** (`UnmatchedStatusRow`, "same email" chip, `annotateThumbs` call sites) into `shared.jsx`/`lib/derive.js` (IMP-033) — lowest effort of the structural items, reduces silent shell drift. *(Architecture)*
10. **Toast/snackbar feedback layer** to replace log-panel-only feedback for saves/edits/fixes, visible regardless of which view the user is on (complements IMP-024). *(UI/UX)*
11. **A visual per-order status timeline** (ordered→shipped→delivered with dates/source emails, beyond ItemSheet's 3-dot tracker) to make Reconcile/Review debugging self-explanatory. *(UI/UX)*
12. **Command palette / keyboard shortcuts for the desktop shell** ("/" to focus search, view-switch shortcuts) — a natural pairing once IMP-018/IMP-023's keyboard-accessibility groundwork exists. *(UI/UX)*
13. **Make `ItemSheet` re-derive live from `c.data`**, matching `OrderSheet`'s existing pattern (full version of IMP-012) — closes a whole class of "stale popup after background mutation" bugs for future features touching item data, not just today's gap. *(Architecture)*

---

## Recommended immediate work order

> **Update 2026-07-10 (same session):** all 18 items below were implemented the
> same night and verified with `npm run build` + logic traces (details in each
> issue's status note above). IMP-006 and IMP-007 shipped as partial
> mitigations; IMP-012 got the full live re-derive rather than the quick patch.

Scope: only P0/P1 issues with LOW or clearly-scoped MEDIUM fix risk, plus LOW-risk quick wins from any priority tier. Anything touching the cloud-sync merge is flagged — verify with build + logic trace, since no automated tests exist.

1. **IMP-002** — In `sync()`, `await connectCloud(token)` (or rebuild `working` from `dataRef.current`) before constructing the working snapshot, so the sync loop never pushes a merge-unaware copy. **Needs extra care: touches cloud-sync merge — verify with build + logic trace.**
2. **IMP-003** — Add a `pendingRemoteMergeRef` flag when a remote update arrives mid-sync, and replay the merge once `syncing` flips back to false. **Needs extra care: touches cloud-sync merge — verify with build + logic trace.**
3. **IMP-001** — Add a `confirm()` to the "Full re-sync" button naming the consequence (wipes all orders including manual edits, re-reads entire Gmail history).
4. **IMP-004** — In `applyDiscounts`, broaden the fallback guard to `base <= 0 && (netMerch > 0 || order.total == null)` so null-total split orders get flagged `estimated` instead of a silent $0.00.
5. **IMP-009** — Add a confirmation dialog to `importData` stating it will replace all current orders (full `mergeState` integration can follow later).
6. **IMP-007** — Wrap the `localStorage` fallback in `storage.set` in its own try/catch, and add a persistent save-failed banner (not just a log line) in `App.jsx`.
7. **IMP-005** — Convert `save()` and its call sites to a functional-update pattern (`save(prev => ...)`) to close the stale-closure lost-edit race. **Needs extra care: `save()` feeds the cloud-sync push path — verify with build + logic trace.**
8. **IMP-006** — Add a lightweight clock-skew warning (log when a merged order's `updatedAt` is implausibly ahead of local `Date.now()`); defer full server-timestamp correction to a later session.
9. **IMP-010** — In `discounts.js`, set `it.listedUnknown = singleItem` so the two flags are genuinely exclusive as documented.
10. **IMP-011** — Fix `isEmptyOrder` to check all orders sharing a `messageId`, not just the first match.
11. **IMP-015** — Wrap each carrier adapter call in `carrier-eta.mjs` in its own try/catch so a throwing adapter doesn't abort the fallback chain.
12. **IMP-018** — Add the existing `Lightbox` Escape-key pattern (plus `role="dialog"`/`aria-modal`) to `ItemSheet`/`OrderSheet`.
13. **IMP-020** — Add a "+ Add item" button to `EditForm` appending a blank item row.
14. **IMP-021** — Add `disabled={c.syncing}` and the matching caption to `EditForm`'s Save button.
15. **IMP-022** — Reword the "Clear all data" confirm text to disclose it also pushes the empty state to Firebase.
16. **IMP-012** — Quick partial fix: have `fixEstimatedPrices`'s button call `onClose()` too, matching `ItemSheet`'s other two action buttons (masks the staleness tonight; full live re-derive is a separate future item).
17. **IMP-027** — Gate the `Empty` state / KPI renders on `c.loaded` to remove the "No orders yet" flash on load.
18. **IMP-016** — Add a backup-snapshot step to the existing `carrier-eta.yml` GitHub Action, copying `manifest/{uid}/state` to a dated backup path.
