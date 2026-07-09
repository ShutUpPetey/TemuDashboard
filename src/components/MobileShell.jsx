import React, { useMemo, useState } from "react";
import {
  RefreshCw, Search, Settings2, BarChart3, ReceiptText,
  LayoutGrid, RotateCcw, AlertTriangle, ExternalLink,
} from "lucide-react";
import {
  CATEGORIES, fmt, pct, isActiveStatus, StatusChip, CropThumb, annotateThumbs, Elapsed, Empty, LogPanel,
  carrierInfoFor, carrierEtaText,
} from "./shared";
import { siblingOrders } from "../lib/derive";
import SettingsPanel from "./SettingsPanel";
import AnalyticsView from "./AnalyticsView";
import ItemSheet from "./ItemSheet";
import OrderSheet from "./OrderSheet";
import { useWindowWidth } from "../hooks/useMediaQuery";

/* ============================================================
   Mobile shell — "Visual Gallery". Item-first card grid, chip
   filters, tap-for-detail bottom sheet (shared ItemSheet), and a
   floating stats dock. Everything cross-links: cards → sheet →
   order → related orders → back to items.
   ============================================================ */

const SORTS = [
  ["date", "Date"],
  ["paid", "Price"],
  ["discountPct", "Discount"],
];

export default function MobileShell({ c }) {
  const [view, setView] = useState("items"); // items | orders | analytics | settings
  const [chip, setChip] = useState("All");   // All | <category> | __transit | __review
  const [sortKey, setSortKey] = useState("date");
  const [sheet, setSheet] = useState(null);  // item row from allItems
  const [sheetOrderId, setSheetOrderId] = useState(null); // OrderSheet target
  const [expandedOrder, setExpandedOrder] = useState(null);
  const winW = useWindowWidth();
  const cardSize = Math.floor((Math.min(winW, 520) - 16 * 2 - 12) / 2);

  /* Open the order POPUP — default way to view an order from the item
     sheet, related-order chips, etc. */
  const openOrder = (orderId) => {
    setSheet(null);
    setSheetOrderId(orderId);
  };

  /* Jump to the order in the Orders LIST (expanded + scrolled) — used by
     the popup's "Show in Orders". */
  const goOrder = (orderId) => {
    setSheet(null);
    setSheetOrderId(null);
    setView("orders");
    setExpandedOrder(orderId);
    setTimeout(() => document.getElementById(`m-order-${orderId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
  };

  const openItemFromOrder = (o, it, i) =>
    setSheet({ ...it, orderId: o.id, date: o.date, status: o.status || "ordered", itemIdx: i });

  const counts = useMemo(() => {
    const activeRows = c.allItems.filter((r) => isActiveStatus(r.status));
    const byCat = {};
    activeRows.forEach((r) => { byCat[r.category] = (byCat[r.category] || 0) + 1; });
    return {
      all: activeRows.length,
      byCat,
      transit: c.allItems.filter((r) => r.status === "shipped").length,
      review: c.review.estimatedItems.length + c.review.emptyOrders.length + c.failedEmails.length,
    };
  }, [c.allItems, c.review, c.failedEmails]);

  const rows = useMemo(() => {
    let r;
    if (chip === "__transit") r = c.allItems.filter((x) => x.status === "shipped");
    else if (chip === "__review") r = c.allItems.filter((x) => x.estimated);
    else if (chip === "All") r = c.allItems.filter((x) => isActiveStatus(x.status));
    else r = c.allItems.filter((x) => isActiveStatus(x.status) && x.category === chip);
    if (c.query) r = r.filter((x) => (x.name || "").toLowerCase().includes(c.query.toLowerCase()));
    return [...r].sort((a, b) => {
      const va = a[sortKey] ?? "", vb = b[sortKey] ?? "";
      if (typeof va === "number" || typeof vb === "number") return (vb || 0) - (va || 0);
      return String(vb).localeCompare(String(va));
    });
  }, [c.allItems, chip, c.query, sortKey]);

  const dock = useMemo(() => {
    const paid = rows.reduce((s, i) => s + (i.paid || 0) * (i.qty || 1), 0);
    const listed = rows.reduce((s, i) => s + (i.listed || 0) * (i.qty || 1), 0);
    return { paid, saved: listed - paid, off: listed > 0 ? 1 - paid / listed : null };
  }, [rows]);

  const chips = [
    ["All", `All`, counts.all],
    ...CATEGORIES.filter((cat) => counts.byCat[cat]).map((cat) => [cat, cat, counts.byCat[cat]]),
    ...(counts.transit ? [["__transit", "🚚 In transit", counts.transit]] : []),
    ...(counts.review ? [["__review", "⚠ Review", counts.review]] : []),
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 pb-28" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <style>{`
        .disp { font-family: 'Archivo', sans-serif; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { scrollbar-width: none; }
      `}</style>

      {/* ---------- Sticky header ---------- */}
      <header className="sticky top-0 z-20 bg-stone-50/90 backdrop-blur border-b border-stone-200">
        {c.syncing && (
          <div className="bg-orange-600 text-white px-4 py-1.5 flex items-center gap-2 text-xs">
            <RefreshCw size={12} className="animate-spin shrink-0" />
            <span className="truncate">{c.log.length ? c.log[c.log.length - 1].msg : "Starting…"}</span>
            <Elapsed className="mono ml-auto shrink-0" />
            <button onClick={c.cancelSync} className="font-bold border border-white/40 rounded px-1.5">✕</button>
          </div>
        )}
        <div className="flex items-center gap-2 px-4 py-2.5">
          <span className="disp font-extrabold text-[15px] tracking-tight">📦 TEMU <span className="text-orange-600">MANIFEST</span></span>
          <div className="relative flex-1 max-w-[220px] ml-auto">
            <Search size={13} className="absolute left-2.5 top-2 text-stone-400" />
            <input value={c.query} onChange={(e) => { c.setQuery(e.target.value); if (view !== "items") setView("items"); }} placeholder={`Search ${counts.all}…`}
              className="w-full pl-7 pr-2 py-1.5 bg-white border border-stone-200 rounded-full text-[13px] focus:outline-none focus:border-orange-400" />
          </div>
          <button onClick={() => c.sync(false)} disabled={c.syncing}
            className="bg-orange-600 disabled:opacity-60 text-white rounded-full px-3.5 py-1.5 text-[13px] font-bold shadow-sm shadow-orange-600/30">
            {c.syncing ? "…" : "⟳ Sync"}
          </button>
        </div>
        {view === "items" && (
          <div className="flex gap-1.5 px-4 pb-2.5 overflow-x-auto no-scrollbar">
            {chips.map(([id, label, n]) => (
              <button key={id} onClick={() => setChip(id)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-semibold border transition-colors ${chip === id ? "bg-stone-900 border-stone-900 text-white" : "bg-white border-stone-200 text-stone-500"}`}>
                {label} <span className="mono text-[10px] opacity-60">{n}</span>
              </button>
            ))}
          </div>
        )}
      </header>

      {/* ---------- Views ---------- */}
      {view === "items" && (
        <>
          <div className="flex items-center px-4 py-2 text-[12px] text-stone-500">
            <span>{rows.length} item{rows.length === 1 ? "" : "s"}</span>
            <div className="ml-auto flex gap-1">
              {SORTS.map(([k, label]) => (
                <button key={k} onClick={() => setSortKey(k)}
                  className={`px-2 py-0.5 rounded-full font-semibold ${sortKey === k ? "bg-stone-200 text-stone-800" : "text-stone-400"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="px-4"><Empty syncing={c.syncing} /></div>
          ) : (
            <div className="grid grid-cols-2 gap-3 px-4">
              {rows.map((it, i) => (
                <ItemCard key={`${it.orderId}-${it.itemIdx}-${i}`} it={it} size={cardSize} onOpen={() => setSheet(it)} />
              ))}
            </div>
          )}
        </>
      )}

      {view === "orders" && (
        <div className="px-4 pt-3 space-y-2">
          {c.data.orders.length === 0 ? <Empty syncing={c.syncing} /> :
            [...c.data.orders].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((o) => {
              const sibs = siblingOrders(c.data.orders, o);
              const live = carrierInfoFor(c.carrier, o);
              const liveEta = carrierEtaText(live);
              return (
                <div key={o.id} id={`m-order-${o.id}`}
                  className={`bg-white border rounded-xl overflow-hidden transition-colors ${expandedOrder === o.id ? "border-orange-300" : "border-stone-200"}`}>
                  <div className="flex items-center gap-2 px-3 py-2.5" onClick={() => setExpandedOrder(expandedOrder === o.id ? null : o.id)}>
                    <div className="min-w-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); openOrder(o.id); }}
                        className={`mono text-[13px] font-semibold active:text-orange-600 ${!isActiveStatus(o.status) ? "line-through text-stone-400" : "text-stone-900"}`}>
                        {o.id}
                      </button>
                      <div className="text-[11px] text-stone-400">{(o.date || "").slice(0, 10)} · {(o.items || []).length} item{(o.items || []).length === 1 ? "" : "s"}{sibs.length > 0 && <span className="text-orange-500"> · split ×{sibs.length + 1}</span>}</div>
                    </div>
                    <div className="ml-auto text-right">
                      <div className="mono text-[14px] font-semibold">{fmt(o.total)}</div>
                      <StatusChip s={o.status || "ordered"} />
                      {live?.status === "Delivered" && o.status === "shipped"
                        ? <div className="text-[10px] text-amber-600 font-semibold mt-0.5">✓ delivered per carrier</div>
                        : (liveEta || (o.status === "shipped" && o.eta))
                          ? <div className="text-[10px] text-blue-600 font-semibold mt-0.5">est. {liveEta || o.eta}</div>
                          : null}
                    </div>
                  </div>
                  {expandedOrder === o.id && (
                    <div className="border-t border-stone-100 px-3 py-2">
                      {annotateThumbs(o.items || []).map((it, i) => (
                        <div key={i} className="flex items-center gap-2.5 py-1.5 border-b border-stone-50 last:border-0"
                          onClick={() => openItemFromOrder(o, it, i)}>
                          <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={38} rounded="rounded-lg" />
                          <div className="min-w-0 flex-1 text-[13px]">{it.name} {it.qty > 1 && <span className="text-stone-400">×{it.qty}</span>}</div>
                          <div className="mono text-[13px] font-semibold">{fmt(it.paid)}{it.estimated && <span className="text-amber-500">≈</span>}</div>
                        </div>
                      ))}
                      <div className="mono text-[10.5px] text-stone-400 pt-2 flex flex-wrap gap-x-3">
                        <span>sub {fmt(o.subtotal)}</span><span>disc −{fmt(o.discount)}</span><span>ship {fmt(o.shipping)}</span><span>tax {fmt(o.tax)}</span>
                      </div>
                      {sibs.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-2 mt-1 border-t border-stone-100">
                          <span className="text-[10.5px] text-stone-400 uppercase tracking-wide">Same email:</span>
                          {sibs.map((s) => (
                            <button key={s.id} onClick={(e) => { e.stopPropagation(); openOrder(s.id); }}
                              className="mono text-[11px] border border-stone-300 rounded-full px-2 py-0.5 text-stone-600 hover:border-orange-400 hover:text-orange-700">
                              {s.id}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-2 mt-2">
                        <button onClick={(e) => { e.stopPropagation(); c.openOrderPage(o); }}
                          className="flex-1 border border-orange-200 bg-orange-50 rounded-lg py-2 text-[12.5px] font-bold text-orange-700">
                          <ExternalLink size={12} className="inline -mt-0.5 mr-1" />Open in Temu
                        </button>
                        {o.tracking?.url && (
                          <button onClick={(e) => { e.stopPropagation(); window.open(o.tracking.url, "_blank"); }}
                            className="flex-1 border border-blue-200 bg-blue-50 rounded-lg py-2 text-[12.5px] font-bold text-blue-700">
                            🚚 Track · {o.tracking.carrier || "carrier"}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {view === "analytics" && (
        <div className="px-4 pt-3">
          <div className="bg-white border border-stone-200 rounded-xl p-3">
            <AnalyticsView c={c} onCategoryClick={(cat) => { setChip(cat); setView("items"); }} />
          </div>
        </div>
      )}

      {view === "settings" && (
        <div className="px-4 pt-3 space-y-3">
          {c.failedEmails.length > 0 && !c.syncing && (
            <button onClick={c.retryFailedEmails}
              className="w-full flex items-center gap-2 bg-amber-50 border border-amber-300 text-amber-800 rounded-xl px-4 py-3 text-sm font-semibold">
              <RotateCcw size={14} /> Retry {c.failedEmails.length} failed email(s)
            </button>
          )}
          <div className="bg-white border border-stone-200 rounded-xl p-4">
            <SettingsPanel c={c} dark={false} />
          </div>
          <LogPanel log={c.log} />
          <div className="text-[11px] text-stone-400 flex items-start gap-1.5 px-1">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            Item names/prices are read from Temu's receipt images by Claude vision — spot-check new orders. "≈" means the price is an even split estimate.
          </div>
        </div>
      )}

      {/* ---------- Detail sheets (shared) ---------- */}
      {sheet && <ItemSheet c={c} it={sheet} onClose={() => setSheet(null)} onViewOrder={openOrder} />}
      {sheetOrderId && (
        <OrderSheet c={c} orderId={sheetOrderId}
          onClose={() => setSheetOrderId(null)}
          onOpenItem={(row) => { setSheetOrderId(null); setSheet(row); }}
          onOpenOrder={(id) => setSheetOrderId(id)}
          onShowInList={goOrder} />
      )}

      {/* ---------- Floating dock ---------- */}
      <nav className="fixed bottom-3 left-1/2 -translate-x-1/2 z-30 bg-stone-900 text-stone-200 rounded-2xl shadow-2xl shadow-black/40 px-3 pt-2.5 pb-2 w-[calc(100%-24px)] max-w-md">
        <div className="flex items-center justify-around pb-2 border-b border-stone-700/70">
          <DockStat k={chip === "All" && !c.query ? "Paid (all)" : "Paid (filtered)"} v={fmt(dock.paid)} cls="text-orange-300" />
          <DockStat k="Saved" v={fmt(dock.saved)} cls="text-emerald-300" />
          <DockStat k="Avg off" v={pct(dock.off)} cls="text-emerald-300" />
        </div>
        <div className="flex items-center justify-around pt-1.5">
          {[["items", LayoutGrid, "Items"], ["orders", ReceiptText, "Orders"], ["analytics", BarChart3, "Charts"], ["settings", Settings2, "Settings"]].map(([id, Icon, label]) => (
            <button key={id} onClick={() => setView(id)}
              className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg text-[10px] font-semibold ${view === id ? "text-orange-300" : "text-stone-400"}`}>
              <Icon size={17} />{label}
              {id === "settings" && counts.review > 0 && <span className="absolute translate-x-3 -translate-y-1 w-2 h-2 rounded-full bg-amber-400" />}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

/* ================= Card ================= */

function ItemCard({ it, size, onOpen }) {
  const off = it.discountPct != null && it.discountPct > 0.005 ? `−${(it.discountPct * 100).toFixed(0)}%` : null;
  const dotCls = it.status === "delivered" ? "bg-emerald-500" : it.status === "shipped" ? "bg-blue-500" : it.status === "cancelled" || it.status === "returned" ? "bg-red-400" : "bg-stone-400";
  const dotGlyph = it.status === "delivered" ? "✓" : it.status === "shipped" ? "✈" : "•";
  return (
    <div onClick={onOpen} className="bg-white border border-stone-200 rounded-2xl overflow-hidden active:scale-[.98] transition-transform cursor-pointer">
      <div className="relative">
        <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={size} rounded="rounded-none" />
        {(off || it.estimated) && (
          <span className={`absolute top-2 left-2 text-white text-[10.5px] font-extrabold rounded-md px-1.5 py-0.5 ${it.estimated ? "bg-amber-500" : "bg-emerald-600"}`}>
            {it.estimated ? "≈ est" : off}
          </span>
        )}
        <span className={`absolute top-2 right-2 w-5 h-5 rounded-full grid place-items-center text-[10px] text-white ${dotCls}`}>{dotGlyph}</span>
      </div>
      <div className="px-2.5 pt-2 pb-2.5">
        <div className="text-[12.5px] font-semibold leading-tight h-8 overflow-hidden">{it.name || "—"}</div>
        <div className="flex items-baseline gap-1.5 mt-1">
          <span className="mono text-[15px] font-semibold">{fmt(it.paid)}</span>
          {!it.estimated && it.listed != null && <span className="text-[11px] text-stone-400 line-through">{fmt(it.listed)}</span>}
        </div>
        <div className="flex justify-between text-[10px] text-stone-400 mt-0.5">
          <span>{it.category}{it.qty > 1 ? ` · ×${it.qty}` : ""}</span>
          <span className="mono">{(it.date || "").slice(5, 10)}</span>
        </div>
      </div>
    </div>
  );
}

function DockStat({ k, v, cls }) {
  return (
    <div className="text-center">
      <div className="text-[8.5px] uppercase tracking-widest text-stone-500 font-semibold">{k}</div>
      <div className={`mono text-[14px] font-semibold ${cls}`}>{v}</div>
    </div>
  );
}
