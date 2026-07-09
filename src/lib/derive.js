/* ============================================================
   Shared derivations consumed by BOTH shells (desktop command
   center + mobile gallery). Pure functions of the stored data —
   no React, no state.
   ============================================================ */

export const isActiveStatus = (s) => s !== "cancelled" && s !== "returned";

/* Annotates each item with how many rows share its receipt image
   (thumbRows), its position among them (thumbIdx), and whether the
   model-reported y coordinates for this image can be trusted outright
   (thumbTrustY).

   Why the trust check: index math assumes the image contains exactly one
   equal-height row per item, but real receipts sometimes have extra rows
   (item variants the model merged), taller rows (two-line names), or
   header/footer padding — index math drifts there, while the model's y
   values, which were read off the actual pixels, stay correct. So when the
   y values are internally consistent (all present, strictly top-to-bottom,
   sensibly spaced apart), CropThumb uses them verbatim; otherwise they're
   treated as noise and index math wins. */
export function annotateThumbs(items) {
  const groups = {};
  for (const it of items) if (it.thumbUrl) (groups[it.thumbUrl] ||= []).push(it);
  const trust = {};
  for (const [url, group] of Object.entries(groups)) {
    const ys = group.map((g) => g.thumbY);
    const rowSpan = 100 / group.length;
    trust[url] =
      ys.every((y) => Number.isFinite(y) && y >= 0 && y <= 100) &&
      ys.every((y, i) => i === 0 || y - ys[i - 1] >= rowSpan * 0.5);
  }
  const seen = {};
  return items.map((it) => {
    if (!it.thumbUrl) return { ...it, thumbRows: 1, thumbIdx: 0, thumbTrustY: false };
    const idx = (seen[it.thumbUrl] = (seen[it.thumbUrl] ?? -1) + 1);
    return { ...it, thumbRows: groups[it.thumbUrl].length, thumbIdx: idx, thumbTrustY: trust[it.thumbUrl] };
  });
}

/* Orders currently on their way. */
export function inTransitOrders(orders) {
  return orders.filter((o) => (o.status || "ordered") === "shipped");
}

/* Everything low-confidence that deserves a human look:
   - items whose price is an even split estimate (split-order emails)
   - orders that parsed with zero items (truncated vision response)
   Failed emails (never parsed at all) are tracked separately in state
   and appended by the caller. */
export function reviewQueue(orders) {
  const estimatedItems = [];
  const emptyOrders = [];
  for (const o of orders) {
    if (!o.items || o.items.length === 0) { emptyOrders.push(o); continue; }
    annotateThumbs(o.items).forEach((it, itemIdx) => {
      if (it.estimated) estimatedItems.push({ ...it, orderId: o.id, date: o.date, status: o.status || "ordered", itemIdx });
    });
  }
  return { estimatedItems, emptyOrders };
}

/* "▲ $212 this month" style delta for the charged KPI: current calendar
   month's spend vs the previous calendar month's. */
export function monthDelta(monthData) {
  if (!monthData || monthData.length === 0) return null;
  const now = new Date().toISOString().slice(0, 7);
  const cur = monthData.find((m) => m.name === now)?.spend ?? 0;
  const prevKey = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).toISOString().slice(0, 7);
  const prev = monthData.find((m) => m.name === prevKey)?.spend ?? 0;
  return { cur, prev, diff: cur - prev };
}

/* Sparkline points ("x,y x,y …") for the last N months of spend, scaled
   into a viewBox of the given width/height. */
export function sparkPoints(monthData, n = 6, w = 100, h = 28) {
  const tail = (monthData || []).slice(-n);
  if (tail.length < 2) return "";
  const max = Math.max(...tail.map((m) => m.spend), 1);
  const pad = 3;
  return tail
    .map((m, i) => {
      const x = (i / (tail.length - 1)) * w;
      const y = h - pad - (m.spend / max) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/* Aggregate stats — moved verbatim from App.jsx so both shells (and the
   overview KPIs) share one implementation. */
export function buildStats(orders, activeOrders, activeItems) {
  const spent = activeOrders.reduce((s, o) => s + (o.total || 0), 0);
  const listed = activeItems.reduce((s, i) => s + (i.listed || 0) * (i.qty || 1), 0);
  const paid = activeItems.reduce((s, i) => s + (i.paid || 0) * (i.qty || 1), 0);
  const totalQty = activeItems.reduce((s, i) => s + (i.qty || 1), 0);
  const byCat = {};
  const byCatQty = {};
  activeItems.forEach((i) => {
    byCat[i.category] = (byCat[i.category] || 0) + (i.paid || 0) * (i.qty || 1);
    byCatQty[i.category] = (byCatQty[i.category] || 0) + (i.qty || 1);
  });
  const byMonth = {};
  activeOrders.forEach((o) => {
    const m = (o.date || "").slice(0, 7) || "?";
    byMonth[m] = (byMonth[m] || 0) + (o.total || 0);
  });
  return {
    spent, listed, paid,
    saved: listed - paid,
    avgDisc: listed > 0 ? 1 - paid / listed : 0,
    avgPerItem: totalQty > 0 ? paid / totalQty : null,
    totalQty,
    catData: Object.entries(byCat).map(([name, v]) => ({
      name,
      spend: +v.toFixed(2),
      qty: byCatQty[name] || 0,
      avgPerItem: byCatQty[name] ? v / byCatQty[name] : null,
    })).sort((a, b) => b.spend - a.spend),
    monthData: Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) => ({ name, spend: +v.toFixed(2) })),
    statuses: ["ordered", "shipped", "delivered", "cancelled", "returned"]
      .map((s) => [s, orders.filter((o) => (o.status || "ordered") === s).length])
      .filter(([, n]) => n > 0),
  };
}
