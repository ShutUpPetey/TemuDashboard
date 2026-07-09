# Option 3 — Visual Gallery

**One-liner:** Flip the hierarchy: items (with their photos) become the primary object instead of orders, laid out as a shopping-app card grid with chip filters, a tap-for-detail sheet, and a floating summary dock.

Open `option-3-visual-gallery.html` in a browser to see it.

## The core UX idea

The most engaging data in this app is the product photos — that's why thumbnail alignment mattered enough to fix. But the current design treats images as 36px afterthoughts in a table. Meanwhile "orders" are really just Temu's shipping groupings; what you *remember* buying is items. This design makes the item card the atom of the whole UI. It's also the only option designed mobile-first, which matters for a "did that thing ship yet?" glance from the couch.

## What changes vs. current design

**Card grid replaces the items table.** Big square photo (the cropped receipt-image thumbnails, finally at a size that earns their keep), discount badge in the corner (−62%), a colored status dot (green check delivered, blue plane in transit), price with struck-through list price. Everything the table row said, now scannable at a glance and touch-friendly.

**Chip rail replaces dropdown filters.** Categories with live counts, plus *smart chips* that cut across categories: **In transit** and **Needs review**. Dropdowns hide the distribution of your stuff; chips show it before you even filter. Horizontally scrollable on mobile.

**Tap → detail sheet.** A bottom sheet (mobile) / side panel (desktop) with a status timeline (Ordered → Shipped → Delivered with dates), full price math, category editing, receipt image, and edit access. This replaces both the expand-chevron and the separate edit mode — one surface for inspecting and correcting.

**Floating summary dock replaces the summary strip.** Charged / Saved / Avg-off ride along at the bottom of the screen, always visible, with an Analytics link. The stats respond to active filters — filter to Kitchen and the dock shows what Kitchen cost you, which turns filtering into an ad-hoc analytics tool and answers most "how much did I…" questions without ever opening the Analytics tab.

**Orders still exist** — one level down. The detail sheet links to its order, and an Orders view lists them receipt-style. They're just no longer the front door.

## Tradeoffs

- Grid is worse than a table for dense comparison/sorting across many attributes (the current table could remain as a toggle: ▦ grid / ☰ list).
- Depends on thumbnail crops being good — the alignment fix just shipped, so this is now viable.
- Order-level financials (tax, shipping breakdown) are a click deeper than today.

## Effort estimate

Medium. The card grid and chips are straightforward; the detail sheet consolidates existing expand + edit flows (net simplification long-term). Filter-aware dock stats are a small derivation of existing memos. ~2 sessions.
