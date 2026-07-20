import React, { useEffect, useState } from "react";
import { Clock, Truck, CheckCircle2, XCircle, Undo2, Package, X, ThumbsUp, ThumbsDown, Repeat, CloudOff } from "lucide-react";

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

export function Empty({ syncing, loaded = true }) {
  // Until IndexedDB has answered, this ISN'T an empty store — it's still
  // loading. Showing "No orders yet" for that first beat reads like data
  // loss on every open of a populated app.
  if (!loaded) {
    return (
      <div className="text-center py-16 text-stone-400 border-2 border-dashed border-stone-200 rounded-sm">
        <Package size={36} className="mx-auto mb-3 text-stone-300 animate-pulse" />
        <div className="disp font-bold text-stone-500">Loading your orders…</div>
      </div>
    );
  }
  return (
    <div className="text-center py-16 text-stone-400 border-2 border-dashed border-stone-200 rounded-sm">
      <Package size={36} className={`mx-auto mb-3 ${syncing ? "text-orange-400 animate-pulse" : "text-stone-300"}`} />
      <div className="disp font-bold text-stone-500">No orders yet</div>
      <div className="text-sm mt-1">{syncing ? "Sync in progress — orders appear as they're read." : "Hit “Check Gmail” to pull in your Temu order emails."}</div>
    </div>
  );
}

/* Amber strip both shells render when cloud sync is configured but not
   actually syncing: an outright error, or a change was saved while
   disconnected (c.cloudDirty). Deliberately NOT shown for a merely
   signed-out state with nothing pending — someone deliberately offline
   isn't nagged — but the moment an edit goes local-only it appears and
   stays until sync reconnects (connectCloud clears cloudDirty after its
   merge+push). This is the "your changes aren't saving to the cloud"
   indicator that used to be one warn line in the log. */
export function CloudBanner({ c, className = "" }) {
  const s = c.cloudState;
  const show = s === "error" || ((s === "off" || s === "connecting") && c.cloudDirty);
  if (!show) return null;
  return (
    <div className={`flex items-center gap-2.5 bg-amber-50 border border-amber-300 text-amber-800 rounded-lg px-3 py-2 text-[12.5px] ${className}`}>
      <CloudOff size={15} className="shrink-0 text-amber-500" />
      <span className="flex-1 leading-snug">
        <b>{s === "error" ? "Cloud sync error" : "Cloud sync is disconnected"}</b>
        {" — "}
        {c.cloudDirty
          ? "recent changes are saved on THIS device only; they'll sync automatically once reconnected."
          : "changes will save on this device only."}
      </span>
      <button onClick={c.handleGoogleSignIn}
        className="shrink-0 font-bold underline underline-offset-2 hover:text-amber-950">
        Reconnect
      </button>
    </div>
  );
}

/* ---------- live carrier tracking (populated by the GitHub Action) ---------- */

export const CARRIER_STATUS_LABEL = {
  InfoReceived: "Label created",
  InTransit: "In transit",
  OutForDelivery: "Out for delivery",
  AvailableForPickup: "Ready for pickup",
  Delivered: "Delivered",
  DeliveryFailure: "Delivery issue",
  Exception: "Exception",
  Expired: "Tracking expired",
  NotFound: "Not found yet",
};

export function carrierInfoFor(carrierMap, order) {
  const n = order?.tracking?.number;
  return (n && carrierMap && carrierMap[n]) || null;
}

const shortDate = (iso) => {
  if (!iso) return null;
  // etaFrom/etaTo are date-only "YYYY-MM-DD" strings (every carrier-eta.mjs
  // adapter normalizes to iso10/ymd). A bare date string parses as UTC
  // midnight, which toLocaleDateString renders as the PREVIOUS day in any
  // timezone behind UTC — parse as local midnight instead (same guard as
  // ArrivingSoonView's day math).
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + "T00:00:00" : iso);
  return isNaN(d) ? null : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/* "Jul 12" or "Jul 12 – Jul 14" from the carrier's estimated window. */
export function carrierEtaText(info) {
  if (!info) return null;
  const a = shortDate(info.etaFrom);
  const b = shortDate(info.etaTo);
  if (a && b && a !== b) return `${a} – ${b}`;
  return a || b || null;
}

export function LogPanel({ log, className = "" }) {
  if (!log.length) return null;
  const errors = log.filter((l) => l.kind === "error" || l.kind === "warn").length;
  const download = () => {
    const text = log.map((l) => `${l.t} [${l.kind}] ${l.msg}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `temu-sync-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className={`relative bg-white border border-stone-300 rounded-sm ${className}`}>
      <div className="flex items-center gap-2 px-2 pt-1.5 text-[10px] text-stone-400">
        <span>{log.length} line(s){errors ? ` · ${errors} warning/error(s)` : ""}</span>
        <button onClick={download} className="ml-auto font-semibold text-blue-600 hover:text-blue-500">↓ Download log</button>
      </div>
      <div className="p-2 pt-1 max-h-36 overflow-y-auto mono text-[11px]">
        {log.map((l, i) => (
          <div key={i} className={l.kind === "error" ? "text-red-600" : l.kind === "warn" ? "text-amber-600" : l.kind === "ok" ? "text-emerald-700" : "text-stone-600"}>
            {l.t} — {l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- rating controls ("Rate items" tab + ItemSheet) ----------
   Shared here (rather than living inside RatingsView.jsx) because
   ItemSheet also needs them for its own rating row — three view-level
   consumers plus ItemSheet, same bar every other shared.jsx widget
   clears. Both are plain, uncontrolled `<button>`s — the caller owns the
   verdict/active state and passes it in, same pattern as StatusChip. */
export function RatingButtons({ verdict, size = "sm", disabled = false, onUp, onDown }) {
  const dim = size === "lg" ? "w-11 h-11" : size === "md" ? "w-9 h-9" : "w-8 h-8";
  const iconSize = size === "lg" ? 20 : size === "md" ? 16 : 15;
  const base = `${dim} rounded-full border grid place-items-center transition-colors active:scale-90 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-1`;
  const upCls = verdict === "up"
    ? "bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-500"
    : "border-stone-300 text-stone-400 hover:border-emerald-400 hover:text-emerald-600 hover:bg-emerald-50";
  const downCls = verdict === "down"
    ? "bg-rose-600 border-rose-600 text-white hover:bg-rose-500"
    : "border-stone-300 text-stone-400 hover:border-rose-400 hover:text-rose-600 hover:bg-rose-50";
  // Tap the active thumb again → clears; tap the opposite thumb → switches
  // directly. Both are decided by the caller (c.rateItem's own toggle
  // logic) — this component just reports which button was pressed.
  return (
    <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <button type="button" disabled={disabled} onClick={onUp} aria-pressed={verdict === "up"}
        aria-label={verdict === "up" ? "Clear rating" : "Like this item"}
        className={`${base} ${upCls}`}>
        <ThumbsUp size={iconSize} />
      </button>
      <button type="button" disabled={disabled} onClick={onDown} aria-pressed={verdict === "down"}
        aria-label={verdict === "down" ? "Clear rating" : "Dislike this item"}
        className={`${base} ${downCls}`}>
        <ThumbsDown size={iconSize} />
      </button>
    </span>
  );
}

/* Only ever rendered/enabled for a liked ("up") item — c.toggleBuyAgain is
   a no-op otherwise (see App.jsx), so the control stays out of the way for
   unrated/disliked rows instead of sitting there doing nothing. */
export function BuyAgainToggle({ active, disabled = false, onToggle, compact = false }) {
  return (
    <button type="button" disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      aria-pressed={active}
      aria-label={active ? "Remove from buy again list" : "Mark as want to buy again"}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-1 ${
        active ? "bg-orange-600 border-orange-600 text-white hover:bg-orange-500" : "border-stone-300 text-stone-400 hover:border-orange-400 hover:text-orange-600 hover:bg-orange-50"
      }`}>
      <Repeat size={compact ? 12 : 13} />{!compact && "Buy again"}
    </button>
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
