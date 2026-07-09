# Option 2 — Paper Ledger

**One-liner:** The app already flirts with a receipt aesthetic (the "tape" summary strip, mono fonts). This option commits completely: every order is a physical receipt on a desk, statuses are rubber stamps, and the whole app feels like a purchase ledger you enjoy flipping through.

Open `option-2-paper-ledger.html` in a browser to see it.

## The core UX idea

This is a *personal* tool for one person tracking cheap, cheerful Temu hauls. It doesn't need to look like enterprise software — it can be delightful. Skeuomorphism is also doing real UX work here, not just decoration: physical metaphors carry state information faster than badges do.

## What changes vs. current design

**Orders become receipts.** Perforated top/bottom edges (CSS mask, no images), slight alternating rotation so the stack feels hand-placed, a bold ruled header with PO number and total. The receipt *is* the expanded view — no chevron-click needed to see items, because the items are the point.

**Statuses become rubber stamps.** DELIVERED in double-ruled green at an angle, SHIPPED in blue, CANCELLED in red with the whole receipt greyed and the PO struck through. A stamp reads from across the room; a small pill badge doesn't. This is the strongest single idea in this option and could be adopted by any of the three designs.

**The summary strip becomes an actual register tape** — dotted leader lines between label and amount, discounts as a negative line item, TOTAL CHARGED as the bold final line, decorative barcode. Same data as today, but it now *reads* like the receipt math it actually is: listed − discounts = charged.

**Tabs become index tabs** poking out from behind the paper, and the header becomes a clipboard clip. Small touches, but they keep the metaphor coherent instead of half-applied.

**Two playful-but-useful extras:**
- *Handwritten annotations* (Caveat font) — a personal-notes field per item ("good ones!", "came broken"). Genuinely useful for a would-I-buy-again ledger, and impossible to confuse with synced data because it looks like your handwriting.
- *Sticky note* pinned to the corner for what's in transit — ambient status without a dedicated page.

## Tradeoffs

- The rotation/stamps/masks need restraint at scale — 38 receipts of wonky paper could tire. (Mitigation: rotation only on the first screenful, or a "tidy stack" toggle.)
- Dense-data tasks (sorting 214 items by discount %) fight the metaphor; the Items tab would stay a plain table on paper texture.
- Aesthetic is love-it-or-leave-it.

## Effort estimate

Low-medium. This is mostly CSS on top of the existing component structure — no new views or data logic required. The notes field is the only new data. ~1–2 sessions.
