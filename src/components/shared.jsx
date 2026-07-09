import React, { useEffect, useState } from "react";
import { Clock, Truck, CheckCircle2, XCircle, Undo2, Package, X } from "lucide-react";

export { isActiveStatus, annotateThumbs } from "../lib/derive";

/* ---------- constants shared by both shells ---------- */
export const CATEGORIES = ["Tools", "Home", "Kitchen", "Outdoors", "Electronics", "Clothing", "Toys", "Auto", "Crafts", "Sports", "Other"];

export const STATUS_META = {
  ordered:   { label: "Ordered",   icon: Clock,        cls: "bg-stone-100 text-stone-600 border-stone-300",     dot: "bg-stone-400" },
  shipped:   { label: "Shipped",   icon: Truck,        cls: "bg-blue-50 text-blue-700 border-blue-300",         dot: "bg-blue-500" },
  delivered: { label: "Delivered", icon: CheckCircle2, cls: "bg-emerald-50 text-emerald-700 border-emerald-300", dot: "bg-emerald-500" },
  cancelled: { label: "Cancelled", icon: XCircle,      cls: "bg-red-50 text-red-700 border-red-300",            dot: "bg-red-500" },
  returned:  { label: "Returned",  icon: Undo2,        cls: "bg-stone-200 text-stone-500 border-stone-400",     dot: "bg-stone-500" },
};

export const fmt = (n) => (n == null || isNaN(n) ? "—" : "$" + Number(n).toFixed(2));
export const pct = (n) => (n == null || isNaN(n) ? "—" : (n * 100).toFixed(0) + "%");
export const numOrNull = (v) => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));

export const THUMB_SIZE_KEY = "temu-thumb-size";
export const THUMB_SIZE_DEFAULT = 36;

/* ---------- status chip ---------- */
export function StatusChip({ s }) {
  const m = STATUS_META[s] || STATUS_META.ordered;
  const I = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 border rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${m.cls}`}>
      <I size={11} /> {m.label}
    </span>
  );
}

/* ---------- receipt-image row crop ---------- */

// Natural-size cache so each receipt image is measured only once no matter
// how many thumbnails reference it.
const imgDimCache = new Map();
export function useImageSize(url) {
  const [dim, setDim] = useState(() => imgDimCache.get(url) || null);
  useEffect(() => {
    if (!url) return;
    const cached = imgDimCache.get(url);
    if (cached) { setDim(cached); return; }
    let alive = true;
    const img = new Image();
    img.onload = () => {
      const d = { w: img.naturalWidth, h: img.naturalHeight };
      imgDimCache.set(url, d);
      if (alive) setDim(d);
    };
    img.src = url;
    return () => { alive = false; };
  }, [url]);
  return url ? dim : null;
}

export function CropThumb({ url, y, rows = 1, idx = 0, trustY = false, size = THUMB_SIZE_DEFAULT, rounded = "rounded-sm", onClick }) {
  // The goods_list PNG is one tall composite — one row per item, product
  // photo on the left. Measures the image's real aspect ratio, scales so
  // ONE row is exactly the thumbnail's height, then centers on this item's
  // row. Vertical position: if this image's model-reported y values passed
  // the consistency check (trustY, see annotateThumbs), use y verbatim —
  // it was read off the actual pixels and survives uneven/extra rows.
  // Otherwise use index math, letting y fine-tune only within its row.
  const dim = useImageSize(url);
  if (!url) return <div className={`bg-stone-100 ${rounded} shrink-0`} style={{ width: size, height: size }} />;

  let bg;
  const n = Math.max(1, rows);
  if (dim && dim.w > 0 && dim.h > 0) {
    const zoom = 1.15; // slight overscan so row padding doesn't dominate
    const dispH = size * n * zoom;
    const dispW = dispH * (dim.w / dim.h);
    const rowSpan = 100 / n;
    const idxY = (idx + 0.5) * rowSpan;
    let yPct;
    if (trustY && y != null) yPct = y;
    else if (y != null && Math.abs(y - idxY) <= rowSpan * 0.6) yPct = y;
    else yPct = idxY;
    const offY = Math.min(Math.max((yPct / 100) * dispH - size / 2, 0), Math.max(dispH - size, 0));
    const offX = Math.min(dispW * 0.025, Math.max(dispW - size, 0));
    bg = {
      backgroundSize: `${dispW.toFixed(1)}px ${dispH.toFixed(1)}px`,
      backgroundPosition: `-${offX.toFixed(1)}px -${offY.toFixed(1)}px`,
    };
  } else {
    bg = { backgroundSize: "420% auto", backgroundPosition: `4% ${y ?? (idx + 0.5) * (100 / n)}%` };
  }
  return (
    <div
      onClick={onClick}
      className={`${rounded} cursor-pointer border border-stone-200 bg-no-repeat bg-white shrink-0 hover:ring-2 hover:ring-orange-300 transition-shadow`}
      style={{ width: size, height: size, backgroundImage: `url(${url})`, ...bg }}
      title="Tap to view full receipt image"
    />
  );
}

/* ---------- misc shared widgets ---------- */

export function Elapsed({ className }) {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className={className}>{s}s</span>;
}

export function Empty({ syncing }) {
  return (
    <div className="text-center py-16 text-stone-400 border-2 border-dashed border-stone-200 rounded-sm">
      <Package size={36} className={`mx-auto mb-3 ${syncing ? "text-orange-400 animate-pulse" : "text-stone-300"}`} />
      <div className="disp font-bold text-stone-500">No orders yet</div>
      <div className="text-sm mt-1">{syncing ? "Sync in progress — orders appear as they're read." : "Hit “Check Gmail” to pull in your Temu order emails."}</div>
    </div>
  );
}

export function LogPanel({ log, className = "" }) {
  if (!log.length) return null;
  return (
    <div className={`bg-white border border-stone-300 rounded-sm p-2 max-h-36 overflow-y-auto mono text-[11px] ${className}`}>
      {log.map((l, i) => (
        <div key={i} className={l.kind === "error" ? "text-red-600" : l.kind === "warn" ? "text-amber-600" : l.kind === "ok" ? "text-emerald-700" : "text-stone-600"}>
          {l.t} — {l.msg}
        </div>
      ))}
    </div>
  );
}

export function Lightbox({ url, onClose }) {
  if (!url) return null;
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6" onClick={onClose}>
      {/* Temu's receipt PNGs are transparent — white backing keeps them readable */}
      <img src={url} alt="" className="max-h-full max-w-full rounded bg-white p-3 shadow-2xl" />
      <button className="absolute top-4 right-4 text-white" aria-label="Close"><X size={24} /></button>
    </div>
  );
}
