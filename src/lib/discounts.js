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

  const factor = base > 0 && netMerch >= 0 ? Math.min(netMerch / base, 1.5) : 1;
  order.discountFactor = factor;
  items.forEach((it) => {
    it.paid = +((it.listed || 0) * factor).toFixed(2);
    it.discountPct = 1 - factor;
  });
  return order;
}
