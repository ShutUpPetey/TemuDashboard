/* ---------- Discount distribution ----------
   Distributes order-level discounts across items proportionally,
   so item.paid reflects what was actually paid. Unchanged from the
   original Claude-artifact version — this is the core feature. */
export function applyDiscounts(order) {
  const items = order.items || [];
  const itemSum = items.reduce((s, it) => s + (it.listed || 0) * (it.qty || 1), 0);
  const sub = order.subtotal && order.subtotal > 0 ? order.subtotal : itemSum;
  let netMerch;
  if (order.total != null) {
    netMerch = order.total - (order.shipping || 0) - (order.tax || 0);
  } else if (order.discount != null) {
    netMerch = sub - order.discount;
  } else {
    netMerch = sub;
  }
  const base = itemSum > 0 ? itemSum : sub;

  // No listed prices at all — this happens with Temu's split-order emails
  // ("Your Temu orders confirmation..."), whose per-order item image shows
  // photo/name/qty but no price (only the real receipt page has that, and
  // it requires a logged-in Temu session we can't access from a static
  // app). Rather than silently paying everything $0.00, fall back to an
  // even per-unit split of the known order total and flag it as estimated.
  if (base <= 0 && netMerch > 0) {
    const totalQty = items.reduce((s, it) => s + (it.qty || 1), 0) || 1;
    const perUnit = netMerch / totalQty;
    // A single-item order has no ambiguity in how the total gets divided —
    // 100% of netMerch belongs to that one item, so `paid` is exact, not a
    // guess. Only the pre-discount LIST price is still unknown (Temu's
    // split preview never showed one). Multi-item orders are genuinely
    // estimated (the split across items is a guess); single-item orders
    // get `listedUnknown` instead — a lower-priority "could fix the list
    // price later" flag rather than a "this price might be wrong" one.
    const singleItem = items.length === 1;
    items.forEach((it) => {
      it.paid = +(perUnit * (it.qty || 1)).toFixed(2);
      it.listed = it.listed || it.paid;
      it.discountPct = null;
      // Mutually exclusive by design (see CLAUDE.md): multi-item = the
      // split itself is a guess (estimated); single-item = paid is exact,
      // only the list price is missing (listedUnknown).
      it.estimated = !singleItem;
      it.listedUnknown = singleItem;
    });
    order.discountFactor = null;
    return order;
  }

  // No listed prices AND no usable total either (e.g. a split email whose
  // per-sub-order "Order total" text failed to extract). Without this
  // branch these items fell through to the proportional path below and
  // were silently priced at a confident-looking $0.00 with a 0% discount
  // and no review flag. Price them as unknown and flag for review so
  // "Try real prices" can recover the numbers from a status email.
  if (base <= 0) {
    items.forEach((it) => {
      it.paid = null;
      it.listed = null;
      it.discountPct = null;
      it.estimated = true;
      it.listedUnknown = false;
    });
    order.discountFactor = null;
    return order;
  }

  // netMerch can be legitimately ≤ 0: an order fully covered by coupon +
  // account credit charges $0.00 total (and the credit may cover shipping
  // and tax too, making total − shipping − tax negative). The per-item
  // paid really is $0.00 there — clamp the factor at 0 instead of bailing
  // to factor 1, which used to display a free item as paid-full-list-price
  // and inflate spend stats by the entire list amount.
  const factor = base > 0 ? Math.min(Math.max(netMerch, 0) / base, 1.5) : 1;
  order.discountFactor = factor;
  // When neither a total nor a discount line was extracted, the factor
  // degenerates to ~1 ("assume sticker price"). On Temu that's nearly
  // always wrong — real receipts always print a total, so a missing one
  // is an extraction failure, not evidence of no discount (a $26.21
  // list item can really cost $1.99). Flag such items estimated so they
  // surface in Review and "Try real prices" can recover the real
  // numbers from a status email, instead of hiding behind a
  // confident-looking full-price figure.
  const unverified = missingChargeEvidence(order);
  items.forEach((it) => {
    it.paid = +((it.listed || 0) * factor).toFixed(2);
    it.discountPct = unverified ? null : 1 - factor;
    if (unverified) {
      it.estimated = true;
      it.listedUnknown = false;
    }
  });
  return order;
}

/* True when the parse produced no evidence of what was actually charged:
   no order total AND no discount line. Kept as its own export so the
   one-time repair pass below and applyDiscounts can't drift apart. */
export function missingChargeEvidence(order) {
  return order.total == null && order.discount == null;
}

/* One-time repair for orders parsed BEFORE the unverified-price flag
   existed: same predicate as applyDiscounts, applied to already-stored
   orders (Reconcile can't help here — it re-applies status emails, it
   doesn't re-run pricing). Mutates in place, stamps order.updatedAt so
   the change wins the per-order cloud merge, returns how many orders
   were flagged. Idempotent: already-flagged items are skipped, so this
   is safe to run on every app load. manualEdit orders are never touched
   (the human's numbers outrank the heuristic). */
export function flagUnverifiedPrices(orders) {
  let changed = 0;
  for (const o of orders || []) {
    if (o.manualEdit || !missingChargeEvidence(o)) continue;
    const items = o.items || [];
    // Only the listed-price path can hide unflagged — the no-listed-price
    // branches of applyDiscounts have always flagged their output.
    if (!items.some((it) => (it.listed || 0) > 0)) continue;
    let touched = false;
    for (const it of items) {
      if (it.estimated || it.listedUnknown) continue;
      it.estimated = true;
      it.discountPct = null;
      touched = true;
    }
    if (touched) {
      o.updatedAt = Date.now();
      changed++;
    }
  }
  return changed;
}
