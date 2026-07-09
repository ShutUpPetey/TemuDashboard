# Migration Brief: Temu Order Manifest → GitHub Pages

## What this is
`temu-order-dashboard.jsx` is a React app built as a Claude.ai artifact. It syncs Temu
order emails from Gmail, uses Claude vision to read item names/prices out of Temu's
image-rendered receipts, distributes order-level discounts across items proportionally,
and shows sortable tables + spend analytics. The UI, data model, discount math
(`applyDiscounts`), sorting, filtering, and charts should all be preserved as-is.

## Target
A static React app (Vite) deployed to GitHub Pages. Personal single-user tool.

## Two platform dependencies that MUST be replaced

### 1. `window.storage` (Claude artifact persistent storage)
Replace with `localStorage` behind the same async interface so call sites barely change:

```js
const storage = {
  get: async (k) => { const v = localStorage.getItem(k); return v ? { value: v } : null; },
  set: async (k, v) => { localStorage.setItem(k, v); return { key: k }; },
};
```
Add JSON export/import buttons (download/upload the full data blob) since localStorage
is per-browser.

### 2. Keyless Anthropic API + Gmail MCP server
The artifact called `https://api.anthropic.com/v1/messages` with no API key and a
`mcp_servers` param pointing at a Claude.ai Gmail connector. Neither works outside
Claude.ai. Replace with:

**Gmail — direct REST API with Google Identity Services (client-side OAuth):**
- Load GIS (`https://accounts.google.com/gsi/client`), use
  `google.accounts.oauth2.initTokenClient` with scope
  `https://www.googleapis.com/auth/gmail.readonly`.
- OAuth Client ID comes from an env var (`VITE_GOOGLE_CLIENT_ID`) — safe to be public.
- Search with these VERIFIED patterns (user's mailbox has ~200 Temu emails, mostly noise):
  - Order confirmations: `from:transaction.temu.com subject:"order confirmation"` —
    subjects look like `Your Temu order confirmation (#PO-211-...)`. A multi-order
    variant exists: `Your Temu orders confirmation on <date>` (no PO in subject).
  - Status: `from:transaction.temu.com subject:(delivered OR shipped OR "transferred to")`
  - The PO number is in the subject — extract with regex `PO-[\d-]+`, no body read needed
    for classification or status matching. Skip review-request emails (customers.temu.com).
- Base endpoint: `GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=<query> after:YYYY/MM/DD`
- Read: `users/me/messages/{id}?format=full` — walk the MIME parts.
- Attachments: `users/me/messages/{id}/attachments/{attachmentId}` returns base64url —
  convert to standard base64. Also grab inline images (Content-ID parts).
- Classify order/shipped/delivered from the Subject header locally (cheap string match:
  "order", "shipped", "delivered") instead of asking Claude — saves API calls. Extract
  the PO-number from subject/body text where present.

**Anthropic — user-supplied API key, browser-direct:**
- Settings panel field for the API key, stored ONLY in localStorage. Never hardcode,
  never commit, no key in the repo.
- Calls to `https://api.anthropic.com/v1/messages` from the browser require headers:
  `x-api-key`, `anthropic-version: 2023-06-01`, and
  `anthropic-dangerous-direct-browser-access: true`.
- Verify current header/CORS requirements against https://docs.claude.com/en/api/overview
  before finalizing.
- Model: keep `claude-sonnet-4-6` (or latest Sonnet). Raise `max_tokens` to ~2000 —
  the artifact was capped at 1000 and large orders risked truncated JSON.
- IMPORTANT (verified against a real order email): Temu order emails have NO
  attachments, and most `<img>`s are marketing. The HTML uses comment markers — the
  ONLY two images that matter per order are inside `<!-- @@goods_list begin/end@@ -->`
  (all purchased items rendered in one tall PNG: photo, name, qty, price per row) and
  `<!-- @@order_pay_info_row begin/end@@ -->` (payment summary: subtotal, discounts,
  shipping, tax, total). The `@@recommend_goods_item@@` sections are "recommended for
  you" ads — never send those to vision. Image URLs are signed (Tencent-COS style
  `sign=` query param, ~1 year validity) — keep the FULL query string.
- Extraction flow: fetch message HTML via Gmail API → regex out the goods_list +
  order_pay_info_row img srcs → ONE vision request per order using URL image source
  blocks (`{"type":"image","source":{"type":"url","url":...}}` — Anthropic's backend
  fetches them). Extract items + money JSON, plus a per-item "y" (vertical % of the
  item's row in the goods image). Thumbnails = CSS background-crop of the goods image
  at that y (no per-item images exist; don't try to split the PNG client-side —
  cross-origin canvas is tainted).

## Keep unchanged
- `applyDiscounts()` proportional discount distribution — this is the core feature.
- Orders / Items / Analytics tabs, sorting, filters, search, lightbox, sync log,
  receipt-strip summary, status chips, auto-sync-if-stale toggle.
- Incremental sync via `processedIds` + `lastSync`.

## Project setup
- Vite + React. Install Tailwind (the JSX uses Tailwind utility classes throughout),
  `lucide-react`, `recharts`.
- Fonts: keep the Google Fonts @import (Archivo + JetBrains Mono).
- `vite.config.js`: set `base: '/<repo-name>/'` for GitHub Pages.
- Deploy: GitHub Actions workflow (peaceiris/actions-gh-pages or the official
  actions/deploy-pages flow) building on push to main.

## One-time Google Cloud setup (document in README for the user)
1. console.cloud.google.com → new project → enable Gmail API.
2. OAuth consent screen: External, Testing mode, add own address as test user.
3. Credentials → OAuth Client ID (Web app) → authorized JavaScript origins:
   `http://localhost:5173` and `https://<user>.github.io`.
4. Put the client ID in `.env` as `VITE_GOOGLE_CLIENT_ID` and in the GitHub Action's
   env (it's public-safe).

## Acceptance checks
- Sign in with Google → "Check Gmail" pulls only new Temu emails since last sync.
- An order with a multi-item receipt image parses into items with correct paid prices
  (listed × discount factor ≈ merchandise total after discount).
- Shipped/delivered emails flip order status by PO number.
- Refresh browser: data persists. Export/import JSON round-trips.
- Works on the deployed github.io URL, not just localhost.
