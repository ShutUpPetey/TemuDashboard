# CLAUDE.md — Project Context for Future Sessions

Read this first. It's the handoff document for the Temu Order Manifest project —
what it is, how it's built, every external moving part, and where work left off.
Keep it updated when architecture or integrations change.

## What this is

A personal dashboard (owner/admin: Matt, github.com/ShutUpPetey) that reads
Temu order emails from Gmail, parses the image-rendered receipts with Claude
vision, tracks items/prices/statuses with live carrier ETAs, and syncs across
devices via Firebase. Static Vite/React app, deployed to GitHub Pages at
`https://shutuppetey.github.io/TemuDashboard/` on every push to `main`.
Started single-user; now optionally multi-user (see "Admin access" below) —
each signed-in Google account gets fully private data, and Matt (only) can
browse everyone's read-only via an Admin panel.

## Current state (July 2026)

Working: Gmail sync + vision parsing, split-order emails, adaptive two-shell UI
(desktop "command center" / mobile "visual gallery"), IndexedDB + Firebase RTDB
cloud sync with per-order merge, order/item detail popups with full
cross-linking, CSV/JSON export, carrier tracking via a scheduled GitHub Action
(Shippo, $0.01/tracking number), auto-promotion of orders to "delivered" from
carrier data, reconcile debugging tools (unmatched-status queue, find &
import, downloadable log), unified multi-field search + filter/sort across
Items and Orders in both shells, `fixEstimatedPrices` recovery of real prices
from later status emails, a two-tier review split between genuinely-estimated
split-order prices and single-item orders whose paid amount is exact but list
price is unknown, an "Arriving Soon" 14-day delivery calendar with
past-guarantee/stale-tracking flags, a much-expanded Analytics tab (KPIs,
a D/W/M/Y stock-chart-style spend-over-time toggle, per-item "ignore from
analytics" with a restore list, a free-items-received list, carrier
performance, funnel, price histogram), a first-run Welcome tour, a "Rate
items" tab (thumbs up/down + buy-again flags on delivered items — see Key
mechanisms), and optional multi-user admin oversight (directory +
read-only "view as user").

**2026-07-10 multi-agent review:** `IMPROVEMENTS.md` (repo root) is the ranked
issue/improvement tracker produced by parallel UI/UX, architecture, and
data/sync reviews. 18 fixes landed the same night (see its status notes) —
headliners: sync() now awaits the cloud merge before snapshotting (was
clobbering cloud data on the first sync of every session), mid-sync remote
updates are parked and replayed instead of dropped, all mutation sites read a
synchronously-updated `dataRef` instead of stale render closures, null-total
split orders get flagged `estimated` instead of silently pricing at $0.00,
Full re-sync/Import now confirm, sheets close on Escape, and the carrier
Action snapshots a daily state backup. Check IMPROVEMENTS.md before starting
new work — it has the remaining P1/P2 backlog and the "bigger ideas" list.

Open threads:

1. **Unrecognized split-email formats.** Some multi-order confirmation emails
   have sub-order IDs the `extractSubOrders` regex misses → those orders never
   get created → their status emails land in the "unmatched" Review queue. The
   app now logs a red warning when it detects this (multiple goods_list images
   but no readable sub-order IDs). NEXT STEP: user provides a raw snippet of
   such an email ("Show original" in Gmail, the "Order ID: PO-…" area) → fix the
   regex in `src/lib/gmail.js → extractSubOrders` → orders recover on Reconcile.
2. **Temu sends no structured "guaranteed by" date.** `arrivingCalendar()`
   (Arriving Soon) falls back to the carrier's own ETA window, or parsed
   email-ETA text, to decide what counts as "overdue" — checked `gmail.js`'s
   extractors to confirm there's nothing better to prefer. If Temu's email
   format ever adds an explicit guarantee date, prefer it ahead of both.
3. Dormant adapters: EasyPost (user's dashboard never showed API keys), direct
   UPS (blocked: needs shipper account w/ scheduled pickups), direct USPS
   (blocked: registration issues), Ship24 (free quota burned), 17TRACK (needs
   business email). All still in `scripts/carrier-eta.mjs` as fall-throughs.
4. **Cloud sync deletion resurrection (known, accepted limitation).** The
   per-order merge (see Key Mechanisms) has no tombstones. If you delete an
   order on one device before that deletion has synced to another device, and
   the other device saves anything before pulling the deletion, the merge (a
   union of both devices' order lists) can bring the deleted order back. Rare
   in practice since deletion is a manual, deliberate action — not fixed
   because it'd require a tombstone system that conflicts with the existing
   "delete to force a clean Reconcile re-read" mechanism (see `hasOrder()`).
   NOTE (2026-07 review): the architecture review found this is more common
   than documented (any device offline at deletion time resurrects on
   reconnect) AND that a tombstone map is compatible with Reconcile-recreate
   after all (a re-read order gets a fresh `updatedAt` newer than the
   tombstone) — see IMPROVEMENTS.md IMP-008 for the design if/when fixing.

## Architecture

`src/App.jsx` is the **data engine** — all state, Gmail sync, parsing, storage,
cloud sync, exports, edit handlers. It builds one `ctx` object and renders one
of two **shells** chosen by viewport (<768px = mobile) or the Settings → Layout
override:

- `src/components/DesktopShell.jsx` — sidebar nav; Overview (KPIs, arriving
  soon, recent orders), Arriving Soon (14-day calendar), Orders (inline expand
  + full edit form), Items table, Analytics, Needs Review queue, Admin
  (admin-only), Settings.
- `src/components/MobileShell.jsx` — card grid, chip filters, floating stats
  dock, bottom-sheet details; Admin is reached via a Settings button rather
  than the fixed 5-icon bottom dock.

Shared: `components/ItemSheet.jsx` + `OrderSheet.jsx` (detail popups; they chain
into each other and to sibling orders), `SettingsPanel.jsx`, `AnalyticsView.jsx`,
`ArrivingSoonView.jsx` (14-day calendar), `WelcomeModal.jsx` (first-run tour),
`AdminPanel.jsx` (admin-only directory + read-only "view as user"),
`shared.jsx` (StatusChip, CropThumb, LogPanel, Lightbox, carrier helpers,
constants), `lib/derive.js` (pure derivations: stats, review queue, siblings,
annotateThumbs, arrivingCalendar), `hooks/useMediaQuery.js`.

Libraries: `lib/gmail.js` (Gmail REST + all email extraction regexes),
`lib/anthropic.js` (browser-direct Claude calls, model `claude-sonnet-5`),
`lib/gis.js` (Google OAuth token client), `lib/firebase.js` (CDN-loaded RTDB
sync, optional — also owns the `_directory` write and admin-only reads, see
Key mechanisms), `lib/storage.js` (IndexedDB with localStorage migration),
`lib/discounts.js` (proportional discount distribution — the core feature),
`lib/syncMerge.js` (per-order cloud sync merge), `lib/exportCsv.js`.

Worker: `scripts/carrier-eta.mjs` run by `.github/workflows/carrier-eta.yml`
(cron every 6h + manual dispatch). Deploy: `.github/workflows/deploy.yml`.

## Data model

Order: `{ id: "PO-211-…", messageId, date, status: ordered|shipped|delivered|
cancelled|returned, subtotal, discount, shipping, tax, total, discountFactor,
items[], images[], orderUrl, eta (email text), tracking: {carrier, number, url},
manualEdit, updatedAt, statusEmailAt }` — `updatedAt` is a PER-ORDER timestamp
(added whenever that order is mutated: status pass, fixEstimatedPrices, manual
edit, carrier promotion) used ONLY for cloud sync merge (see Key Mechanisms);
unrelated to the top-level state's `updatedAt`, and NOT the same thing as
`statusEmailAt` — see "Recently delivered" in Key Mechanisms for why the two
are deliberately different signals. Item: `{ name, listed, paid, qty, category, discountPct,
estimated, listedUnknown, thumbUrl, thumbY }` — `estimated` means `paid` itself
is a guess (multi-item split order, even-split fallback); `listedUnknown`
means `paid` is exact but the pre-discount `listed` price was never shown
(single-item split order — see `applyDiscounts` in `lib/discounts.js`); the
two flags are mutually exclusive. Store: `{ orders, processedIds, ratings,
lastSync, autoSync, updatedAt }` under IndexedDB key `temu-manifest-v1`,
mirrored to Firebase `manifest/{uid}/state` as `{json, updatedAt}`.
Ratings: `ratings` is a top-level map `{ "orderId:itemIdx": { verdict:
"up"|"down"|null, buyAgain: bool, ratedAt: ms } }` (key = `analyticsItemKey`)
— deliberately NOT stored on item objects (items have no stable id and
their arrays get wholesale-replaced by re-reads), and NOT localStorage-only
like the analytics ignore list (a rating is a fact, not a view preference,
so it syncs). Keys are never deleted; clearing a thumb writes
`verdict: null` with a fresh `ratedAt`, which propagates as a genuine
clear instead of resurrecting via the union merge.

Cloud backups (written ONLY by the GitHub Action): `manifest/{uid}/backups/
{YYYY-MM-DD}` = `{json, savedAt}` — one snapshot of the state blob per day,
7-day retention, taken by `carrier-eta.mjs` each run. Restore = copy a
backup's `json` over `manifest/{uid}/state/json` in the Firebase console,
then refresh the app.

Carrier records (written ONLY by the GitHub Action, app just subscribes):
`manifest/{uid}/carrier/{trackingNumber}` = `{ registered, provider, status
(InfoReceived|InTransit|OutForDelivery|AvailableForPickup|Delivered|
DeliveryFailure|Exception|Expired|NotFound), subStatus, etaFrom, etaTo,
eventTime, eventDesc, checkedAt, trackerId?/easypostId? }`.

Directory record (written by EVERY signed-in user, read only by admin — see
"Admin access" in External services): `manifest/_directory/{uid}` = `{ email,
lastSeen }`, stamped by `lib/firebase.js → cloudSignIn` on every successful
Firebase sign-in.

## Key mechanisms (don't rediscover these)

- **Split-order emails**: one message → several orders sharing `messageId`.
  Reconcile re-examines every split email and vision-parses only missing/empty
  sub-orders. `siblingOrders()` powers the "same email" UI.
- **Status matching**: subject PO first; else `extractPoFromBody` prefers
  `parent_order_sn=` in links (first-PO-in-HTML picks wrong siblings). Reconcile
  (wide) re-applies ALL status emails in history (cheap, idempotent,
  oldest-first). Unmatched ones are NOT marked processed; they go to
  `unmatchedStatus` state → Review queue → "Find & import" (with a manual
  PO-paste field when no PO could be read at all, and the Gmail link there
  deep-links to the exact message via `#all/<messageId>`, not a search).
- **PO-less status emails (tracking-number fallback)**: Temu's forwarded
  "UPS My Choice" delivery notifications (subject literally "Your package
  has been delivered") never mention the PO anywhere — subject or body —
  only a carrier tracking number. Since the order's earlier "shipped" email
  DOES carry both the PO and that same tracking number, the status-email
  loop in `App.jsx` falls back to matching an existing order by
  `tracking.number` when no PO can be extracted. Oldest-first ordering
  means the shipped email (which sets `tracking.number`) is always applied
  before its delivered follow-up. If still unmatched, the tracking number
  (when found) is carried into `unmatchedStatus` as `trackingNumber` and
  shown in the Review queue row for context.
- **Same-day status ordering (`at` vs `date`)**: `order.date` / most sorts
  historically stored day-only precision (`toISOString().slice(0,10)`),
  which broke same-day sequencing — e.g. an "out-for-delivery" email
  (bucketed as "shipped") and the "delivered" email a few hours later both
  land on the same calendar day, and day-only sort left them in whatever
  order Gmail's search API happened to return, sometimes applying the
  earlier one AFTER the delivered one and flipping the order back to
  "shipped". Email objects built in `sync()` now also carry `at` (full ISO
  timestamp) used ONLY for sorting; `date` stays day-only for storage/
  display. Fixed by a Reconcile once deployed.
- **Order links**: the real Temu order page is the `cmsg_transit.html` /
  `_order_ticket=` link (`isOrderDetailLink`). Change-address links also contain
  the PO — that bug was fixed; stale stored links self-heal on click.
- **Fixing estimated prices from a status email (`fixEstimatedPrices`)**:
  split-order confirmation emails often have no per-item price (Temu only
  gives the combined total), so those items get an even-split estimate.
  BUT every later status email for that PO — shipped, out-for-delivery,
  delivered — embeds the same `goods_list` + `order_pay_info_row` image
  pair as a normal single-order confirmation, this time with real prices
  (confirmed by inspecting an actual delivered-notification email's raw
  HTML — the breakdown is an image, not scrapable text, but it IS a
  fully-priced receipt). `fixEstimatedPrices(orderId)` searches for such a
  status email, re-runs the normal (non-split) vision parse against its
  images, and replaces the order's items/totals with the real numbers —
  one vision call, manual-trigger only (Review queue "Try real prices" /
  ItemSheet's "≈ Estimated" action), never automatic. Result is marked
  `manualEdit` so it can't be silently reverted by a later re-read of the
  (still priceless) split confirmation.
- **Carrier → status promotion**: an effect in App.jsx auto-flips shipped →
  delivered when carrier data says Delivered.
- **Auth persistence & the local-only banner (2026-07-16)**: the Gmail
  token (GIS implicit flow) lives ~1h and can't be extended — but it CAN
  be refreshed with no UI via `prompt:""` once consent exists, so
  `gis.js` now only forces the `consent` screen before the FIRST grant
  (`temu-gmail-consented` marker); `getToken({interactive:false})` and an
  on-open + every-10-min-when-expired silent refresh keep it alive while
  the browser's Google session lasts. Separately, cloud sync no longer
  depends on that token at all after the first sign-in: Firebase persists
  its own long-lived session, and `connectCloud(null)` restores it via
  `cloudRestore()` (`firebase.js`) on every open. When a save happens
  while cloud is configured-but-disconnected (or `cloudSet` fails),
  `cloudDirty` flips and BOTH shells show `CloudBanner` (`shared.jsx`):
  "changes saved on THIS device only" + a Reconnect button
  (`handleGoogleSignIn`, which tears down any broken connect state so the
  retry actually reconnects). `cloudDirty` clears on any successful
  cloudSet or connect-merge. A 60s interval also keeps the sidebar's
  signed-in dot honest instead of green-forever.
- **Per-order cloud sync merge (`lib/syncMerge.js`)**: cloud sync used to
  treat the whole app state as one JSON blob with "newest top-level
  `updatedAt` wins" — a stale device making ANY save (even an unrelated
  status update, or the carrier auto-promote effect just running) could
  clobber a fresher edit to a DIFFERENT order made on another device,
  because its save's fresh top-level timestamp didn't reflect the edit it
  didn't know about. Concretely: this is why a `fixEstimatedPrices` ("Try
  real prices") fix on one device could vanish after a refresh on another.
  Fixed by giving every ORDER its own `updatedAt`, stamped at every mutation
  site (`saveEdit`, `updateItem`, the carrier-promote effect,
  `processOrderEmail`'s two `applyDiscounts` calls, `fixEstimatedPrices`, and
  the status-email pass in `sync()`). `connectCloud` (both the initial pull
  and the live `cloudSubscribe` listener) now calls `mergeState()`, which
  takes the UNION of both devices' order lists and keeps whichever copy of
  EACH order is actually newer (`mergeOrders`) — no whole-side "wins."
  `remoteIsStale()` decides whether to push the merged result back to
  Firebase so both sides converge; `sameOrderSet()` is a cheap id+timestamp
  fingerprint check the live listener uses to recognize its own echo (avoids
  a save→notify→merge→save loop). `processedIds` merges as a plain union
  (never lossy). Known gap: no tombstones for deletions — see Open threads.
  Hardened 2026-07-10: `connectCloud` is one shared awaitable promise;
  `sync()`/`rereadOrder`/`importMissingOrder`/`retryFailedEmails` build
  their `working` snapshot from `dataRef.current` AFTER awaiting it (the
  old pre-merge snapshot used to overwrite the cloud on the first sync of
  a session). `dataRef.current` is written SYNCHRONOUSLY at every mutation
  (save/applyRemote/connectCloud) and every mutation handler reads it —
  never the `data` render closure — so same-tick mutations can't drop each
  other. Remote payloads arriving mid-sync are parked in `pendingRemoteRef`
  and replayed through `applyRemote()` when syncing ends. On connect the
  app also measures device clock skew against Firebase server time
  (`cloudClockSkew`) and warns in the log above 2 minutes, since the merge
  trusts client `Date.now()` stamps.
- **Two-tier price review (`estimated` vs `listedUnknown`)**: `applyDiscounts`'
  no-listed-price fallback (split-order confirmations with only a combined
  total) used to flag every resulting item `estimated`. Now it only does that
  for multi-item orders, where dividing the total across items is genuinely a
  guess. A single-item order has no such ambiguity — 100% of the total
  belongs to the one item, so `paid` is exact — so those get `listedUnknown`
  instead: a lower-priority "could still fill in the list price later" flag,
  not a "this number might be wrong" one. `reviewQueue()` in `lib/derive.js`
  splits these into two buckets, `estimatedItems` and `listPriceUnknownItems`;
  only the former counts toward the urgent Review badge. Both shells' Review
  view and ItemSheet show a distinct 🏷 treatment for `listedUnknown` (vs the
  amber "≈" for `estimated`), and both can trigger `fixEstimatedPrices` to try
  recovering the real numbers from a later status email. Since 2026-07-10
  `applyDiscounts` also has a `base <= 0` catch-all: when there are no listed
  prices AND no usable total (e.g. a split email whose per-sub-order total
  failed to extract), items get `paid: null` + `estimated: true` instead of
  the old silent, unflagged $0.00.
- **Analytics: spend-over-time period toggle, per-item ignore, free items
  (`AnalyticsView.jsx` + `lib/derive.js`)**: `spendByPeriod(orders, period,
  ignoredKeys)` buckets ACTIVE ORDERS' charged totals by day/week/month/year
  for a stock-chart-style D/W/M/Y toggle. It starts from each order's actual
  `total` (not a re-sum of its items — that total also covers shipping/tax,
  which items don't carry) and then SUBTRACTS the paid amount of any ignored
  item within that order, so the "ignore from analytics" toggle moves this
  chart too — first shipped as order-level-only and exempt from the ignore
  list, but users expect ignoring an item to remove it from analytics
  everywhere, not just some views, so it was changed to subtract per-item.
  The "ignore from analytics" feature itself (an "Ignore" button on each Top
  Items row) is a per-device, localStorage-only preference
  (`temu-analytics-ignore-v1`, keyed by `analyticsItemKey()` =
  `orderId:itemIdx`) — NOT synced to Firebase/IndexedDB and NOT written to
  order data, since it's a view preference ("this one gift skews my spend
  stats"), not a fact about the order. App.jsx filters `activeItems` down to
  `analyticsItems` (ignored items removed) before calling `buildStats()`, so
  every ITEM-driven stat (top items, category spend, price histogram,
  saved/avg-discount) respects the ignore list. The hero "Total spent
  (lifetime)" KPI (`s.spent`, from `buildStats`'s `activeOrders.reduce`) and
  funnel/carrier/delivery-time stats are the one place STILL intentionally
  unaffected by the ignore list — they're built straight from `activeOrders`,
  not `analyticsItems` — since "lifetime total charged" is meant to stay a
  pure fact even while other views let you declutter around a one-off
  expensive item. A separate "Ignored from analytics" section lists ignored
  items with a Restore button. `freeItems()` (also `lib/derive.js`) lists
  delivered items priced at exactly `paid === 0` with `listed > 0` — i.e. genuinely
  coupon/credit-covered per the `ba5db1c` discount-factor-clamp fix, not
  merely estimated-as-zero. `spendByPeriod` also fills EVERY intermediate
  day/week/month/year between the first and last active order with a
  $0-spend bucket (`stepKey()`), instead of only emitting keys that have an
  order — a chart that silently skips empty buckets draws adjacent orders
  as if they were next to each other in time even when they're weeks
  apart, which (per user report) reads as "the dates are off." Building
  and stepping through those keys had a real timezone bug: `new
  Date("YYYY-MM-DD")` (no time component) parses as UTC MIDNIGHT per spec,
  so in any timezone behind UTC that instant falls on the PREVIOUS local
  day — `periodKey`/`stepKey` (`lib/derive.js`) and `periodLabel`
  (`AnalyticsView.jsx`) all now build/format dates from explicit Y/M/D
  components (`new Date(y, m, d)`, always local) and never round-trip
  through `.toISOString()` or `new Date(dateOnlyString)`, so bucket keys
  and their on-chart labels can't drift a day off in either direction
  regardless of the viewer's timezone.
- **Unified search + filter/sort (`lib/derive.js`: `matchesQuery`,
  `itemSearchIndex`, `orderSearchIndex`)**: the single search box (shared
  state, `c.query`) now matches across BOTH Items and Orders views in both
  shells, against any field — item name/category, PO number, date, status,
  carrier, tracking number, ETA, sibling item names, etc — via a flattened
  lowercased index string per row (`idx()` helper) and a plain substring
  test. The Orders view (previously unfiltered/unsortable in both shells) now
  has a status filter and a sort control (date/total/status/PO on desktop;
  date/total on mobile), matching the Items view's existing filter/sort
  pattern.
- **Arriving Soon calendar (`arrivingCalendar()` in `lib/derive.js`)**: buckets
  every non-delivered, non-cancelled/returned item onto a forward calendar
  (nominally 14 days, `days` param). The desktop grid always starts on a
  Sunday and ends on a Saturday like a real calendar — so a column is always
  the same weekday in every row — which grows the actual range to 14-20 days
  depending on today's weekday (back to this week's Sunday, forward to the
  Saturday completing the week containing today+13). The leading pre-today
  days are pure alignment filler: nothing is ever bucketed into them (an
  overdue item still only shows in `overdueItems`, never duplicated onto its
  past due-date), they just render muted instead of the "—" empty-day
  placeholder. `today` is returned separately since `calendar[0]` is no
  longer necessarily today. Mobile's day list already skips empty days, so
  it's unaffected — the leading filler days are simply never shown there.
  "Expected date" prefers the live carrier ETA window (`etaTo`, falling back
  to `etaFrom`) over the parsed email-ETA text (`etaEndDate` in `gmail.js`),
  since Temu doesn't send a structured "guaranteed by" date anywhere
  currently scraped (see Open threads). An item is **overdue** once its
  expected date has passed without a `Delivered` carrier status — flagged
  regardless of whether that date is still inside the visible window, via a
  separate always-visible alert banner. **Stale** (a distinct, lower-severity
  flag) means the carrier hasn't reported anything in 48h+ while still
  `InTransit`/`OutForDelivery`/`AvailableForPickup`, and isn't already
  overdue (overdue takes precedence, never double-badged). Items with
  no carrier data AND no parseable email ETA go in a separate "no estimate
  yet" bucket — but only once `shipped` (an `ordered` item simply hasn't
  shipped yet, which isn't a gap worth flagging).
- **Recently delivered (`arrivingCalendar()`'s `recentlyDelivered`)**: delivered
  items from the last 7 days, newest first, shown as a green chip strip below
  "No estimate yet" so items that were arriving/overdue/stale can be seen
  resolving instead of just disappearing the moment they're marked delivered.
  No status-change history is kept anywhere in the data model (orders only
  store their CURRENT status), so "when was this delivered" (`deliveredAtFor`)
  is necessarily a proxy, in order of preference: (1) the carrier's own
  `eventTime` when available — the actual delivery scan; (2) `order.statusEmailAt`
  — the delivered EMAIL's own date; (3) `order.updatedAt`, for orders promoted
  to delivered by the carrier-promote effect rather than an email; (4)
  `order.date` as a last resort. `statusEmailAt` is deliberately a SEPARATE
  field from `updatedAt`: `updatedAt` is stamped at sync time (App.jsx's
  status-email loop), which can be days after the real event — a Reconcile
  applies a whole backlog of old status emails in one pass, or the app just
  might not be opened often — while `statusEmailAt` is stamped from the
  email's own date (`em.at || em.date`). `updatedAt` answers "when did this
  browser find out"; `statusEmailAt` answers "when did Temu say it happened."
  Using `updatedAt` here originally made "Xd ago" reflect sync timing instead
  of real delivery timing — fixed by adding `statusEmailAt`.
- **Admin access (optional multi-user)**: default is still effectively
  single-tenant-per-uid — Firebase rules already scope `manifest/{uid}` to
  that uid, so separate signed-in accounts can't see each other regardless of
  admin config. Setting `VITE_ADMIN_EMAIL` (see External services) adds an
  **Admin** nav entry, visible only when the signed-in Firebase user's email
  matches it (`App.jsx`'s `isAdmin`, a UI-only check — the real enforcement
  is the Firebase rule on `auth.token.email`, see README). `AdminPanel.jsx`
  lists everyone in `_directory` and, on "View data", does a ONE-TIME
  `cloudGetUserState(uid)` read-only fetch (`lib/firebase.js`) into separate
  React state (`adminViewUid`/`adminViewState`) — never merged into `data`,
  never subscribed live, never written anywhere. There is no code path by
  which viewing another user's data could write to their tree or the
  admin's own; a bug here fails closed (Firebase rules reject it) rather
  than open.
- **Item ratings ("Rate items" tab, `RatingsView.jsx`)**: thumbs up/down +
  independent buy-again flag (gated to liked items; un-liking auto-clears
  it) on DELIVERED items only. Three sections: to-rate queue (newest
  delivered first, ranked by the same `deliveredAtFor` chain Arriving
  Soon's "recently delivered" uses), Liked/Unliked panels, buy-again list —
  all derived by `ratingQueues()` (`lib/derive.js`). Cloud sync: ratings
  merge per-key newest-`ratedAt`-wins via `mergeRatings`
  (`lib/syncMerge.js`); the live-listener echo check and push-back
  staleness check BOTH consider ratings (`sameRatingSet`/
  `remoteRatingsStale`) — orders-only checks would silently drop a
  ratings-only change. Because keys are positional (`orderId:itemIdx`),
  every path that wholesale-replaces an order's `items[]` (rereadOrder,
  fixEstimatedPrices, fixAllEstimatedPrices, AND the full re-sync rebuild
  in `sync(true)`) re-keys that order's ratings by case-insensitive name
  match via `remapRatingsAfterReplace` — unmatched ratings are DROPPED,
  never mis-attached. Rating an item does NOT stamp the order's
  `updatedAt` (it's not an order mutation). Mobile reaches the tab via a
  Settings-panel button (the Admin pattern); the tab is desktop-nav
  between Analytics and Needs Review, with a plain-gray unrated count
  (deliberately not amber — a backlog isn't a problem).
- **Thumbnails (CropThumb)**: receipt PNG is one tall image; crop math uses
  measured natural size + rows-per-image; trusts Claude's `y` only when the
  image's y-values are monotonic and sanely spaced (`annotateThumbs`).
- **Manual edits**: `manualEdit: true` orders are never overwritten by sync;
  only explicit Re-read (forceId) replaces them, keeping status/eta/link.
- **ETA precedence in UI**: live carrier ETA > email-extracted `order.eta`
  (labeled "(from email)").

## External services & credentials inventory

- **Google OAuth client** (Matt's Google Cloud project): client ID in `.env` as
  `VITE_GOOGLE_CLIENT_ID`, scopes `gmail.readonly openid email profile`. Origins
  allowed: `http://localhost:5173`, `https://shutuppetey.github.io`. App is in
  "Testing" mode with Matt as test user (expect the unverified-app warning).
  Letting other people use the app at all means adding their Google account
  to this same Testing-mode **Test users** list (Google Cloud Console →
  Audience tab, up to 100) — no code/repo change, purely a console click. Full
  Production verification (to drop the allowlist entirely) is a bigger,
  separate undertaking, not done.
- **Anthropic API key**: entered in app Settings, lives only in browser
  localStorage per device, per person. Never in the repo. Already
  multi-user-safe as-is — no change needed for other people to bring their
  own key.
- **Firebase project `temu-dashboard-962d6`**: RTDB (rules: `auth.uid`
  matching `manifest/$uid`, plus an optional admin carve-out on both
  `manifest/$uid` and `manifest/_directory` keyed on `auth.token.email` — see
  README → "Admin access" for the exact rule JSON), Google auth provider
  enabled with the OAuth client ID safelisted ("external project client
  IDs"). Web config values in `.env` (`VITE_FIREBASE_*`) — public-safe.
- **Admin email** (`VITE_ADMIN_EMAIL`, optional): Matt's email, gates the
  Admin panel client-side; the Firebase rule on `auth.token.email` is the
  actual security boundary, this is only a UI show/hide. Unset = admin panel
  never renders for anyone (original single-user behavior).
- **GitHub repo ShutUpPetey/TemuDashboard**. Repo **Variables** (public-safe,
  used by both workflows): `VITE_GOOGLE_CLIENT_ID`, `VITE_FIREBASE_API_KEY`,
  `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_DATABASE_URL`,
  `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_ADMIN_EMAIL`. Repo
  **Secrets**: `SHIPPO_KEY` (live token `shippo_live_…` — the test token errors
  with "not a valid test tracking carrier"), `FIREBASE_SERVICE_ACCOUNT` (full
  JSON), plus possibly leftover `SHIP24_KEY` etc. (harmless fallbacks).
- **Shippo**: free Starter plan + card; $0.01 per unique tracking number,
  polling free.
- Pages: Settings → Pages → Source = GitHub Actions.

## Conventions & gotchas

- **User environment**: Windows, PowerShell 5.x — `&&` does NOT work; give
  commands on separate lines. User runs git pushes themselves (credentials
  shouldn't pass through the assistant).
- Repo name must stay `TemuDashboard` (matches `base` in vite.config.js).
- `.env` is gitignored; values are public-safe identifiers anyway.
- Build check: `npm run build` (Vite). No tests exist; verification is
  build + logic spot-checks.
- The vision prompts in `processOrderEmail` are carefully worded (JSON-only,
  `gi`/`y` thumbnail coordinates, null over guessing) — change cautiously.
- `processedIds` grows forever by design; `hasOrder()` checks real orders, not
  processedIds, so deletions recover via Reconcile.
- Sync log: 400 lines, downloadable via LogPanel button.
- Reconcile = full-history, additive, never overwrites hand-edits. Full re-sync
  = destructive re-read of everything. Re-read (per order) = forced single-order
  re-parse.

## Notes for the assistant (Cowork/Claude sessions)

- The sandbox's mounted view of this folder can serve **stale/truncated file
  contents** (NUL-padded or cut at old file sizes). The Read/Write/Edit file
  tools are authoritative — trust them, not `cat` via bash. For build
  verification, copy src to /tmp, strip NULs (`tr -d '\0'`), check content
  markers per changed file, and repair stale copies by re-applying the edits
  (python string replacement) before `npm run build`. Never commit from the
  sandbox mount.
- Present options via AskUserQuestion before big builds; user prefers concise
  responses; build → verify → short summary with exact next steps (secrets,
  buttons to click) works well.
- History of provider dead-ends (don't re-suggest naively): 17TRACK needs a
  business email; Ship24 free = 10/month (burned); EasyPost dashboard hid API
  keys behind billing for this user; UPS developer portal requires a shipper
  account with scheduled pickups; USPS registration also failed.

## Debugging playbook (for the user)

Statuses stuck → run Reconcile; check log's "Status pass" summary; unmatched
POs appear in Needs Review with "Find & import" + Gmail links. Missing orders →
Reconcile first, then Find & import per PO, then Reconcile again to apply their
status emails. Wrong items/prices → pencil edit (desktop) or item sheet Edit
(mobile). Deleted-item recovery → order's ↺ Re-read button. Carrier ETAs stale →
Actions tab → "Carrier ETA refresh" → Run workflow; log lists each number and
adapter. Cloud sync issues → Settings shows state; usual suspects are the OAuth
origin list and Firebase authorized domains.
