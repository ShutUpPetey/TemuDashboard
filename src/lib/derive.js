/* ============================================================
   Shared derivations consumed by BOTH shells (desktop command
   center + mobile gallery). Pure functions of the stored data —
   no React, no state.
   ============================================================ */

import { etaEndDate } from "./gmail";

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

/* ---------- Arriving Soon calendar ----------
   Checked gmail.js's extractors (extractEta, extractTracking, extractSubOrders)
   for a structured "guaranteed by X" field — Temu doesn't send one anywhere
   currently scraped; the only delivery-date signals are the carrier's own
   etaFrom/etaTo window (written to Firebase by scripts/carrier-eta.mjs) and
   free-text "estimated delivery"/"arriving by" phrasing pulled out of the
   email body (extractEta + etaEndDate). So "expected date" below prefers the
   live carrier window (etaTo, falling back to etaFrom if only one is known —
   consistent with carrierEtaText's own preference in shared.jsx) and falls
   back to the parsed email ETA text when there's no carrier record yet. */
const STALE_HOURS = 48;
const CARRIER_ACTIVE_STATUSES = ["InTransit", "OutForDelivery", "AvailableForPickup"];

function asDay(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
}

/* Buckets every non-delivered, non-cancelled/returned item onto a 14-day
   forward calendar (today..today+days-1) for the "Arriving Soon" view.
   carrierMap is the same manifest/{uid}/carrier/{trackingNumber} data
   App.jsx already subscribes to and passes around as `c.carrier`.

   Returns:
   - calendar: [{date: "YYYY-MM-DD", items: [...]}, ...] for the visible window
   - overdueItems: items whose expected date has passed without a Delivered
     carrier status — may reference dates OUTSIDE the visible window
   - noEstimateItems: shipped items with no carrier data and no parseable
     email ETA at all (can't be placed on the calendar). "ordered" items
     with no ETA yet are NOT included here — they simply haven't shipped,
     which isn't a gap worth flagging. */
export function arrivingCalendar(orders, carrierMap = {}, days = 14) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const dayList = Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const today = dayList[0];
  const windowSet = new Set(dayList);
  const perDay = Object.fromEntries(dayList.map((d) => [d, []]));

  const overdueItems = [];
  const noEstimateItems = [];

  for (const o of orders) {
    const status = o.status || "ordered";
    if (status === "delivered" || !isActiveStatus(status)) continue;
    const info = (o.tracking?.number && carrierMap[o.tracking.number]) || null;
    const delivered = info?.status === "Delivered";

    annotateThumbs(o.items || []).forEach((it, itemIdx) => {
      let expected = info ? asDay(info.etaTo || info.etaFrom) : null;
      if (!expected) expected = etaEndDate(o.eta);

      const row = {
        ...it, orderId: o.id, date: o.date, status, itemIdx,
        expected, carrierStatus: info?.status || null, trackingInfo: info,
      };

      if (!expected) {
        if (status === "shipped") noEstimateItems.push(row);
        return;
      }

      const overdue = !delivered && expected < today;
      const stale = !overdue && !delivered && !!info?.checkedAt
        && CARRIER_ACTIVE_STATUSES.includes(info.status)
        && Date.now() - new Date(info.checkedAt).getTime() > STALE_HOURS * 3600e3;

      const full = { ...row, overdue, stale };
      if (overdue) overdueItems.push(full);
      if (windowSet.has(expected)) perDay[expected].push(full);
    });
  }

  return {
    calendar: dayList.map((date) => ({ date, items: perDay[date] })),
    overdueItems,
    noEstimateItems,
  };
}

/* Orders that arrived in the SAME email as this one (Temu split-order
   emails bundle several POs into one message) — they share a messageId. */
export function siblingOrders(orders, order) {
  if (!order?.messageId) return [];
  return orders.filter((o) => o.messageId === order.messageId && o.id !== order.id);
}

/* Everything low-confidence that deserves a human look:
   - items whose price is an even split estimate (split-order emails,
     more than one item — the split itself is a guess)
   - orders that parsed with zero items (truncated vision response)
   Failed emails (never parsed at all) are tracked separately in state
   and appended by the caller.

   listPriceUnknownItems is a SEPARATE, lower-priority bucket: single-item
   split orders, where the amount paid is exact (100% of the order total
   belongs to that one item — no split ambiguity) but the pre-discount list
   price was never shown. Not "wrong", just "could be filled in later" —
   deliberately excluded from the urgent review count. */
export function reviewQueue(orders) {
  const estimatedItems = [];
  const listPriceUnknownItems = [];
  const emptyOrders = [];
  for (const o of orders) {
    if (!o.items || o.items.length === 0) { emptyOrders.push(o); continue; }
    annotateThumbs(o.items).forEach((it, itemIdx) => {
      const row = { ...it, orderId: o.id, date: o.date, status: o.status || "ordered", itemIdx };
      if (it.estimated) estimatedItems.push(row);
      else if (it.listedUnknown) listPriceUnknownItems.push(row);
    });
  }
  return { estimatedItems, listPriceUnknownItems, emptyOrders };
}

/* ---------- search index helpers ----------
   One flat, lowercased, space-joined string per row/order so a single
   search box can match ANY field — item name, PO number, date, status,
   category, carrier, tracking number, etc — with a plain substring test.
   Shared by both shells so Items and Orders search behave identically. */
const idx = (fields) => fields.filter((f) => f != null && f !== "").map(String).join("   ").toLowerCase();

export function matchesQuery(haystack, query) {
  if (!query) return true;
  return haystack.includes(query.trim().toLowerCase());
}

// `it` is an annotated allItems row (orderId, date, status already mixed in).
export function itemSearchIndex(it) {
  return idx([
    it.name, it.category, it.orderId, it.date, it.status,
    it.estimated ? "estimated" : "", it.listedUnknown ? "list price unknown" : "",
  ]);
}

export function orderSearchIndex(o) {
  return idx([
    o.id, o.date, o.status || "ordered", o.tracking?.carrier, o.tracking?.number,
    o.eta, o.manualEdit ? "edited manual" : "",
    ...(o.items || []).map((it) => it.name),
  ]);
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

/* A package's delivery time is only knowable via the carrier tracker's
   eventTime — the timestamp of its last known event, which coincides with
   the delivery event once the carrier reports Delivered. There is no
   separate "when did this order's status flip to delivered" timestamp
   anywhere in the data model (orders keep only their CURRENT status, not a
   status history), so this is the best available proxy, and only exists
   for orders that (a) have a tracking number and (b) were picked up by the
   carrier-eta GitHub Action. */
function deliveryDaysFor(order, carrierMap) {
  const info = order.tracking?.number && carrierMap ? carrierMap[order.tracking.number] : null;
  if (!info || info.status !== "Delivered" || !info.eventTime || !order.date) return null;
  const ordered = new Date(order.date);
  const delivered = new Date(info.eventTime);
  if (isNaN(ordered) || isNaN(delivered)) return null;
  const days = (delivered - ordered) / 86400000;
  return days >= 0 ? days : null;
}

const PRICE_BUCKETS = [
  { label: "$0–5", min: 0, max: 5 },
  { label: "$5–10", min: 5, max: 10 },
  { label: "$10–20", min: 10, max: 20 },
  { label: "$20–35", min: 20, max: 35 },
  { label: "$35–60", min: 35, max: 60 },
  { label: "$60+", min: 60, max: Infinity },
];

/* Aggregate stats — moved verbatim from App.jsx so both shells (and the
   overview KPIs) share one implementation. `carrierMap` (live tracker data,
   keyed by tracking number) is optional so existing callers keep working;
   pass it to unlock delivery-time-derived stats. */
export function buildStats(orders, activeOrders, activeItems, carrierMap = {}) {
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
  const byMonthCount = {};
  activeOrders.forEach((o) => {
    const m = (o.date || "").slice(0, 7) || "?";
    byMonth[m] = (byMonth[m] || 0) + (o.total || 0);
    byMonthCount[m] = (byMonthCount[m] || 0) + 1;
  });
  const monthData = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, v]) => ({ name, spend: +v.toFixed(2), count: byMonthCount[name] || 0 }));
  const busiestMonth = monthData.length ? monthData.reduce((a, b) => (b.count > a.count ? b : a)) : null;

  const deliveryDaysList = [];
  activeOrders.forEach((o) => {
    const days = deliveryDaysFor(o, carrierMap);
    if (days != null) {
      deliveryDaysList.push({ orderId: o.id, days, carrier: o.tracking?.carrier || "Unknown", itemName: (o.items || [])[0]?.name || o.id });
    }
  });
  const avgDeliveryDays = deliveryDaysList.length
    ? deliveryDaysList.reduce((s, d) => s + d.days, 0) / deliveryDaysList.length
    : null;
  const fastestDelivery = deliveryDaysList.length
    ? deliveryDaysList.reduce((a, b) => (b.days < a.days ? b : a))
    : null;

  const carrierGroups = {};
  activeOrders.forEach((o) => {
    const name = o.tracking?.carrier;
    if (!name) return;
    (carrierGroups[name] ||= { name, count: 0, daysList: [] }).count++;
  });
  deliveryDaysList.forEach((d) => { if (carrierGroups[d.carrier]) carrierGroups[d.carrier].daysList.push(d.days); });
  const carrierData = Object.values(carrierGroups).map((g) => ({
    name: g.name,
    count: g.count,
    avgDays: g.daysList.length ? g.daysList.reduce((s, d) => s + d, 0) / g.daysList.length : null,
  })).sort((a, b) => b.count - a.count);

  const topItems = [...activeItems]
    .map((it) => ({ ...it, amount: (it.paid || 0) * (it.qty || 1) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  const priceHistogram = PRICE_BUCKETS.map((b) => ({
    label: b.label,
    count: activeItems.reduce((s, it) => {
      const p = it.paid ?? 0;
      return s + (p >= b.min && p < b.max ? (it.qty || 1) : 0);
    }, 0),
  }));

  let biggestDiscount = null;
  let priciestItem = null;
  activeItems.forEach((it) => {
    const amount = (it.paid || 0) * (it.qty || 1);
    if (!priciestItem || amount > priciestItem.amount) priciestItem = { name: it.name, orderId: it.orderId, amount };
    if (it.listed != null && !it.listedUnknown) {
      const disc = (it.listed - (it.paid || 0)) * (it.qty || 1);
      if (disc > 0 && (!biggestDiscount || disc > biggestDiscount.amount)) biggestDiscount = { name: it.name, orderId: it.orderId, amount: disc };
    }
  });

  const funnel = {
    ordered: activeOrders.length,
    shipped: activeOrders.filter((o) => ["shipped", "delivered"].includes(o.status || "ordered")).length,
    delivered: activeOrders.filter((o) => (o.status || "ordered") === "delivered").length,
    cancelled: orders.filter((o) => o.status === "cancelled").length,
    returned: orders.filter((o) => o.status === "returned").length,
  };

  return {
    spent, listed, paid,
    saved: listed - paid,
    avgDisc: listed > 0 ? 1 - paid / listed : 0,
    avgPerItem: totalQty > 0 ? paid / totalQty : null,
    totalQty,
    orderCount: activeOrders.length,
    catData: Object.entries(byCat).map(([name, v]) => ({
      name,
      spend: +v.toFixed(2),
      qty: byCatQty[name] || 0,
      avgPerItem: byCatQty[name] ? v / byCatQty[name] : null,
    })).sort((a, b) => b.spend - a.spend),
    monthData,
    busiestMonth,
    statuses: ["ordered", "shipped", "delivered", "cancelled", "returned"]
      .map((s) => [s, orders.filter((o) => (o.status || "ordered") === s).length])
      .filter(([, n]) => n > 0),
    avgDeliveryDays, deliveryDaysSampleSize: deliveryDaysList.length, fastestDelivery,
    carrierData, topItems, priceHistogram, biggestDiscount, priciestItem, funnel,
  };
}
