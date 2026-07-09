/* ============================================================
   CSV export — items and orders. Plain RFC-4180-style CSV
   (quoted fields, UTF-8 BOM so Excel opens it correctly).
   ============================================================ */

function csvField(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvField).join(",")];
  for (const r of rows) lines.push(r.map(csvField).join(","));
  // ﻿ (BOM) makes Excel detect UTF-8 instead of mangling accents.
  return "﻿" + lines.join("\r\n");
}

export function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const round2 = (n) => (n == null || isNaN(n) ? "" : Number(n).toFixed(2));

// rows: flattened item rows ({...item, orderId, date, status}) — the same
// shape App.jsx's allItems/filteredItems use, so the Items tab can export
// exactly what's currently filtered.
export function itemsCsvFromRows(rows) {
  return toCsv(
    ["Order ID", "Date", "Status", "Item", "Category", "Qty", "Listed $", "Paid $", "Discount", "Estimated"],
    rows.map((r) => [
      r.orderId,
      r.date || "",
      r.status || "ordered",
      r.name || "",
      r.category || "",
      r.qty || 1,
      round2(r.listed),
      round2(r.paid),
      r.discountPct != null ? (r.discountPct * 100).toFixed(1) + "%" : "",
      r.estimated ? "yes" : "",
    ])
  );
}

export function itemsCsv(orders) {
  const rows = [];
  for (const o of orders) {
    for (const it of o.items || []) {
      rows.push({ ...it, orderId: o.id, date: o.date, status: o.status || "ordered" });
    }
  }
  return itemsCsvFromRows(rows);
}

export function ordersCsv(orders) {
  const rows = orders.map((o) => [
    o.id,
    o.date || "",
    o.status || "ordered",
    (o.items || []).length,
    (o.items || []).reduce((s, it) => s + (it.qty || 1), 0),
    round2(o.subtotal),
    round2(o.discount),
    round2(o.shipping),
    round2(o.tax),
    round2(o.total),
    o.manualEdit ? "yes" : "",
  ]);
  return toCsv(
    ["Order ID", "Date", "Status", "Line items", "Units", "Subtotal $", "Discount $", "Shipping $", "Tax $", "Charged $", "Hand-edited"],
    rows
  );
}
