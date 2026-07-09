# CLAUDE.md — Project Context for Future Sessions

Read this first. It's the handoff document for the Temu Order Manifest project —
what it is, how it's built, every external moving part, and where work left off.
Keep it updated when architecture or integrations change.

## What this is

A personal, single-user dashboard (owner: Matt, github.com/ShutUpPetey) that reads
Temu order emails from Gmail, parses the image-rendered receipts with Claude
vision, tracks items/prices/statuses with live carrier ETAs, and syncs across
devices via Firebase. Static Vite/React app, deployed to GitHub Pages at
`https://shutuppetey.github.io/TemuDashboard/` on every push to `main`.

## Current state (July 2026)

Working: Gmail sync + vision parsing, split-order emails, adaptive two-shell UI
(desktop "command center" / mobile "visual gallery"), IndexedDB + Firebase RTDB
cloud sync, order/item detail popups with full cross-linking, CSV/JSON export,
carrier tracking via a scheduled GitHub Action (Shippo, $0.01/tracking number),
auto-promotion of orders to "delivered" from carrier data, reconcile debugging
tools (unmatched-status queue, find & import, downloadable log), unified
multi-field search + filter/sort across Items and Orders in both shells,
`fixEstimatedPrices` recovery of real prices from later status emails, and a
two-tier review split between genuinely-estimated split-order prices and
single-item orders whose paid amount is exact but list price is unknown.

Open threads:

1. **Unrecognized split-email formats.** Some multi-order confirmation emails
   have sub-order IDs the `extractSubOrders` regex misses → those orders never
   get created → their status emails land in the "unmatched" Review queue. The
   app now logs a red warning when it detects this (multiple goods_list images
   but no readable sub-order IDs). NEXT STEP: user provides a raw snippet of
   such an email ("Show original" in Gmail, the "Order ID: PO-…" area) → fix the
   regex in `src/lib/gmail.js → extractSubOrders` → orders recover on Reconcile.
2. Dormant adapters: EasyPost (user's dashboard never showed API keys), direct
   UPS (blocked: needs shipper account w/ scheduled pickups), direct USPS
   (blocked: registration issues), Ship24 (free quota burned), 17TRACK (needs
   business email). All still in `scripts/carrier-eta.mjs` as fall-throughs.
3. **Cloud sync deletion resurrection (known, accepted limitation).** The
   per-order merge (see Key Mechanisms) has no tombstones. If you delete an
   order on one device before that deletion has synced to another device, and
   the other device saves anything before pulling the deletion, the merge (a
   union of both devices' order lists) can bring the deleted order back. Rare
   in practice since deletion is a manual, deliberate action — not fixed
   because it'd require a tombstone system that conflicts with the existing
   "delete to force a clean Reconcile re-read" mechanism (see `hasOrder()`).

## Architecture

`src/App.jsx` is the **data engine** — all state, Gmail sync, parsing, storage,
cloud sync, exports, edit handlers. It builds one `ctx` object and renders one
of two **shells** chosen by viewport (<768px = mobile) or the Settings → Layout
override:

- `src/components/DesktopShell.jsx` — sidebar nav; Overview (KPIs, arriving
  soon, recent orders), Orders (inline expand + full edit form), Items table,
  Analytics, Needs Review queue, Settings.
- `src/components/MobileShell.jsx` — card grid, chip filters, floating stats
  dock, bottom-sheet details.

Shared: `components/ItemSheet.jsx` + `OrderSheet.jsx` (detail popups; they chain
into each other and to sibling orders), `SettingsPanel.jsx`, `AnalyticsView.jsx`,
`shared.jsx` (StatusChip, CropThumb, LogPanel, Lightbox, carrier helpers,
constants), `lib/derive.js` (pure derivations: stats, review queue, siblings,
annotateThumbs), `hooks/useMediaQuery.js`.

Libraries: `lib/gmail.js` (Gmail REST + all email extraction regexes),
`lib/anthropic.js` (browser-direct Claude calls, model `claude-sonnet-5`),
`lib/gis.js` (Google OAuth token client), `lib/firebase.js` (CDN-loaded RTDB
sync, optional), `lib/storage.js` (IndexedDB with localStorage migration),
`lib/discounts.js` (proportional discount distribution — the core feature),
`lib/syncMerge.js` (per-order cloud sync merge), `lib/exportCsv.js`.

Worker: `scripts/carrier-eta.mjs` run by `.github/workflows/carrier-eta.yml`
(cron every 6h + manual dispatch). Deploy: `.github/workflows/deploy.yml`.

## Data model

Order: `{ id: "PO-211-…", messageId, date, status: ordered|shipped|delivered|
cancelled|returned, subtotal, discount, shipping, tax, total, discountFactor,
items[], images[], orderUrl, eta (email text), tracking: {carrier, number, url},
manualEdit, updatedAt }` — `updatedAt` is a PER-ORDER timestamp (added whenever
that order is mutated: status pass, fixEstimatedPrices, manual edit, carrier
promotion) used ONLY for cloud sync merge (see Key Mechanisms); unrelated to
the top-level state's `updatedAt`. Item: `{ name, listed, paid, qty, category, discountPct,
estimated, listedUnknown, thumbUrl, thumbY }` — `estimated` means `paid` itself
is a guess (multi-item split order, even-split fallback); `listedUnknown`
means `paid` is exact but the pre-discount `listed` price was never shown
(single-item split order — see `applyDiscounts` in `lib/discounts.js`); the
two flags are mutually exclusive. Store: `{ orders, processedIds, lastSync,
autoSync, updatedAt }` under IndexedDB key `temu-manifest-v1`, mirrored to
Firebase `manifest/{uid}/state` as `{json, updatedAt}`.

Carrier records (written ONLY by the GitHub Action, app just subscribes):
`manifest/{uid}/carrier/{trackingNumber}` = `{ registered, provider, status
(InfoReceived|InTransit|OutForDelivery|AvailableForPickup|Delivered|
DeliveryFailure|Exception|Expired|NotFound), subStatus, etaFrom, etaTo,
eventTime, eventDesc, checkedAt, trackerId?/easypostId? }`.

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
  recovering the real numbers from a later status email.
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
- **Anthropic API key**: entered in app Settings, lives only in browser
  localStorage per device. Never in the repo.
- **Firebase project `temu-dashboard-962d6`**: RTDB (rules: only `auth.uid`
  matching `manifest/$uid`), Google auth provider enabled with the OAuth client
  ID safelisted ("external project client IDs"). Web config values in `.env`
  (`VITE_FIREBASE_*`) — public-safe.
- **GitHub repo ShutUpPetey/TemuDashboard**. Repo **Variables** (public-safe,
  used by both workflows): `VITE_GOOGLE_CLIENT_ID`, `VITE_FIREBASE_API_KEY`,
  `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_DATABASE_URL`,
  `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`. Repo **Secrets**:
  `SHIPPO_KEY` (live token `shippo_live_…` — the test token errors with
  "not a valid test tracking carrier"), `FIREBASE_SERVICE_ACCOUNT` (full JSON),
  plus possibly leftover `SHIP24_KEY` etc. (harmless fallbacks).
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
