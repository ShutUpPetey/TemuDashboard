import React, { useMemo, useState } from "react";
import {
  RefreshCw, Package, ChevronDown, ChevronRight, AlertTriangle, Search, X,
  Settings2, Download, RotateCcw, Pencil, Save, Trash2, LayoutDashboard,
  ReceiptText, Tags, BarChart3, Truck, ExternalLink, CalendarDays, ShieldCheck,
} from "lucide-react";
import {
  CATEGORIES, STATUS_META, fmt, pct, isActiveStatus,
  StatusChip, CropThumb, annotateThumbs, Elapsed, Empty, LogPanel,
  carrierInfoFor, carrierEtaText, CARRIER_STATUS_LABEL,
} from "./shared";
import { sparkPoints, monthDelta, siblingOrders, matchesQuery, itemSearchIndex, orderSearchIndex, arrivingCalendar } from "../lib/derive";
import { etaEndDate } from "../lib/gmail";
import { estimateCostPerCall } from "../lib/anthropic";
import SettingsPanel from "./SettingsPanel";
import AnalyticsView from "./AnalyticsView";
import ArrivingSoonView from "./ArrivingSoonView";
import AdminPanel from "./AdminPanel";
import ItemSheet from "./ItemSheet";
import OrderSheet from "./OrderSheet";

/* ============================================================
   Desktop shell — "Command Center". Persistent sidebar, Overview
   landing page with KPIs/queues, dense tables. All data + handlers
   come from ctx (`c`), built in App.jsx.
   ============================================================ */

export default function DesktopShell({ c }) {
  const [view, setView] = useState("overview");
  const [expanded, setExpanded] = useState({});
  const [catFilter, setCatFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sort, setSort] = useState({ key: "date", dir: -1 });
  const [orderStatusFilter, setOrderStatusFilter] = useState("All");
  const [orderSort, setOrderSort] = useState({ key: "date", dir: -1 });
  const [sheetItem, setSheetItem] = useState(null);     // shared ItemSheet target
  const [sheetOrderId, setSheetOrderId] = useState(null); // shared OrderSheet target

  const reviewCount = c.review.estimatedItems.length + c.review.emptyOrders.length + c.failedEmails.length + c.unmatchedStatus.length;
  const delta = monthDelta(c.stats.monthData);
  const overdueCount = useMemo(() => arrivingCalendar(c.data.orders, c.carrier, 14).overdueItems.length, [c.data.orders, c.carrier]);

  /* Open the order POPUP — the default way to view an order from anywhere
     (overview rows, item order-links, related-order chips, item sheet). */
  const openOrder = (orderId) => {
    setSheetItem(null);
    setSheetOrderId(orderId);
  };

  /* Jump to the order in the Orders LIST (expanded + scrolled) — used by
     the popup's "Show in Orders" and the edit flow. */
  const goOrder = (orderId) => {
    setSheetItem(null);
    setSheetOrderId(null);
    setView("orders");
    setExpanded((e) => ({ ...e, [orderId]: true }));
    setTimeout(() => document.getElementById(`d-order-${orderId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
  };

  const goEditOrder = (orderId) => {
    const order = c.data.orders.find((o) => o.id === orderId);
    if (!order) return;
    goOrder(orderId);
    if (!c.syncing) c.startEdit(order);
  };

  /* Analytics → filtered Items view */
  const goItemsFiltered = ({ cat = "All", status = "All" } = {}) => {
    setCatFilter(cat);
    setStatusFilter(status);
    c.setQuery("");
    setView("items");
  };

  const filteredItems = useMemo(() => {
    let rows = statusFilter === "All"
      ? c.allItems.filter((r) => isActiveStatus(r.status))
      : c.allItems.filter((r) => r.status === statusFilter);
    if (catFilter !== "All") rows = rows.filter((r) => r.category === catFilter);
    // Multi-field: matches item name, category, PO number, date, or status —
    // not just the name — so "16151" or "delivered" finds items too.
    if (c.query) rows = rows.filter((r) => matchesQuery(itemSearchIndex(r), c.query));
    const { key, dir } = sort;
    return [...rows].sort((a, b) => {
      const va = a[key] ?? "", vb = b[key] ?? "";
      if (typeof va === "number" || typeof vb === "number") return ((va || 0) - (vb || 0)) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [c.allItems, c.query, catFilter, statusFilter, sort]);

  /* Orders search/filter/sort — mirrors Items'. Search matches PO number,
     date, status, carrier/tracking number, and item names within the
     order (orderSearchIndex), not just the PO. */
  const filteredOrders = useMemo(() => {
    let rows = orderStatusFilter === "All"
      ? c.data.orders
      : c.data.orders.filter((o) => (o.status || "ordered") === orderStatusFilter);
    if (c.query) rows = rows.filter((o) => matchesQuery(orderSearchIndex(o), c.query));
    const { key, dir } = orderSort;
    const val = (o) => key === "total" ? (o.total || 0) : key === "id" ? o.id : key === "status" ? (o.status || "ordered") : (o.date || "");
    return [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === "number" || typeof vb === "number") return ((va || 0) - (vb || 0)) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [c.data.orders, c.query, orderStatusFilter, orderSort]);

  const th = (label, key, num) => (
    <th
      className={`px-2 py-2 text-xs font-semibold uppercase tracking-wider cursor-pointer select-none whitespace-nowrap ${num ? "text-right" : "text-left"} text-stone-500 hover:text-stone-900`}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : num ? -1 : 1 }))}
    >
      {label}{sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
    </th>
  );

  const NAV = [
    ["overview", "Overview", LayoutDashboard, null],
    ["arriving", "Arriving soon", CalendarDays, overdueCount || null],
    ["orders", "Orders", ReceiptText, c.data.orders.length],
    ["items", "Items", Tags, c.allItems.length],
    ["analytics", "Analytics", BarChart3, null],
    ["review", "Needs review", AlertTriangle, reviewCount || null],
    ...(c.isAdmin ? [["admin", "Admin", ShieldCheck, null]] : []),
    ["settings", "Settings", Settings2, null],
  ];
  const WARN_NAV = { review: reviewCount, arriving: overdueCount };
  const TITLES = { overview: "Overview", arriving: "Arriving soon", orders: "Orders", items: "Items", analytics: "Analytics", review: "Needs review", admin: "Admin", settings: "Settings" };

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 flex" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <style>{`
        .disp { font-family: 'Archivo', sans-serif; }
        .mono { font-family: 'JetBrains Mono', monospace; }
      `}</style>

      {/* ---------- Sidebar ---------- */}
      <aside className="w-56 shrink-0 bg-stone-900 text-stone-300 flex flex-col p-3 sticky top-0 h-screen">
        <div className="flex items-center gap-2 px-2 py-3 mb-2">
          <span className="w-7 h-7 rounded-md bg-orange-600 grid place-items-center"><Package size={16} className="text-white" /></span>
          <span className="disp font-extrabold text-white text-sm tracking-tight">TEMU MANIFEST</span>
        </div>
        {NAV.map(([id, label, Icon, count]) => (
          <button key={id} onClick={() => setView(id)}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] font-medium text-left transition-colors ${view === id ? "bg-orange-600/20 text-orange-300" : "hover:bg-white/5"}`}>
            <Icon size={15} className={WARN_NAV[id] ? "text-amber-400" : ""} />
            {label}
            {count != null && <span className={`ml-auto mono text-[11px] ${WARN_NAV[id] ? "text-amber-400" : "text-stone-500"}`}>{count}</span>}
          </button>
        ))}
        <div className="mt-auto border-t border-stone-800 pt-3 px-2 text-[11px] text-stone-500 leading-relaxed">
          <span className={c.googleSignedIn ? "text-emerald-400" : "text-stone-500"}>●</span>{" "}
          {c.googleSignedIn ? "Gmail connected" : "Not signed in"}<br />
          {c.data.lastSync ? `synced ${new Date(c.data.lastSync).toLocaleString()}` : "never synced"}
          {!c.syncing && (
            <button onClick={() => c.sync(false)} className="block text-orange-400 hover:text-orange-300 underline underline-offset-2 mt-1">sync now</button>
          )}
        </div>
      </aside>

      {/* ---------- Main ---------- */}
      <main className="flex-1 min-w-0">
        {/* syncing banner */}
        {c.syncing && (
          <div className="bg-orange-600 text-white">
            <div className="px-6 py-2 flex items-center gap-2 text-sm">
              <RefreshCw size={14} className="animate-spin shrink-0" />
              <span className="truncate">{c.log.length ? c.log[c.log.length - 1].msg : "Starting…"}</span>
              <Elapsed className="mono text-xs ml-auto shrink-0" />
              <button onClick={c.cancelSync} className="text-xs font-bold border border-white/40 rounded-sm px-2 py-0.5 hover:bg-white/10">Cancel</button>
            </div>
          </div>
        )}

        <div className="px-6 py-5 max-w-6xl">
          {/* topbar */}
          <div className="flex items-center gap-3 mb-5">
            <h1 className="disp text-xl font-extrabold tracking-tight">{TITLES[view]}</h1>
            {(view === "items" || view === "orders") && (
              <div className="relative">
                <Search size={14} className="absolute left-2 top-2.5 text-stone-400" />
                <input value={c.query} onChange={(e) => c.setQuery(e.target.value)}
                  placeholder={view === "items" ? "Search items — name, PO, date, status…" : "Search orders — PO, date, status, carrier…"}
                  className="pl-7 pr-2 py-1.5 border border-stone-300 rounded-md text-sm w-72 bg-white focus:outline-none focus:border-orange-500" />
              </div>
            )}
            <div className="ml-auto flex items-center gap-2">
              {!c.syncing && c.failedEmails.length > 0 && (
                <button onClick={c.retryFailedEmails}
                  className="disp inline-flex items-center gap-1 text-xs font-bold text-amber-700 border border-amber-400 bg-amber-50 px-3 py-2 rounded-md transition-colors hover:bg-amber-100">
                  <RotateCcw size={13} /> Retry failed ({c.failedEmails.length})
                </button>
              )}
              <button onClick={view === "items" ? c.exportItemsCsv : c.exportOrdersCsv}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-stone-600 hover:text-stone-900 border border-stone-300 bg-white px-3 py-2 rounded-md transition-colors">
                <Download size={14} /> Export
              </button>
              <button onClick={() => c.sync(false)} disabled={c.syncing}
                className="disp inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-500 disabled:opacity-60 text-white font-bold px-4 py-2 rounded-md text-sm transition-colors shadow-sm">
                <RefreshCw size={15} className={c.syncing ? "animate-spin" : ""} />
                {c.syncing ? "Syncing…" : "Check Gmail"}
              </button>
            </div>
          </div>

          <LogPanel log={c.log} className="mb-4" />

          {view === "overview" && <Overview c={c} delta={delta} reviewCount={reviewCount} goView={setView} goOrder={openOrder} />}
          {view === "arriving" && <ArrivingSoonView c={c} openItem={setSheetItem} />}
          {view === "orders" && (
            <OrdersView c={c} orders={filteredOrders} expanded={expanded} setExpanded={setExpanded} goOrder={openOrder} openItem={setSheetItem}
              orderStatusFilter={orderStatusFilter} setOrderStatusFilter={setOrderStatusFilter}
              orderSort={orderSort} setOrderSort={setOrderSort} hasQuery={!!c.query} />
          )}
          {view === "items" && (
            <ItemsView c={c} filteredItems={filteredItems} th={th}
              catFilter={catFilter} setCatFilter={setCatFilter}
              statusFilter={statusFilter} setStatusFilter={setStatusFilter}
              openItem={setSheetItem} goOrder={openOrder} />
          )}
          {view === "analytics" && (
            <div className="bg-white border border-stone-200 rounded-lg p-4">
              <AnalyticsView c={c}
                onCategoryClick={(cat) => goItemsFiltered({ cat })}
                onStatusClick={(status) => goItemsFiltered({ status })} />
            </div>
          )}
          {view === "review" && <ReviewView c={c} goEditOrder={goEditOrder} />}
          {view === "admin" && c.isAdmin && <AdminPanel c={c} />}
          {view === "settings" && (
            <div className="bg-stone-900 rounded-lg p-5 max-w-3xl"><SettingsPanel c={c} dark /></div>
          )}
        </div>
      </main>

      {sheetItem && <ItemSheet c={c} it={sheetItem} onClose={() => setSheetItem(null)} onViewOrder={openOrder} desktop />}
      {sheetOrderId && (
        <OrderSheet c={c} orderId={sheetOrderId} desktop
          onClose={() => setSheetOrderId(null)}
          onOpenItem={(row) => { setSheetOrderId(null); setSheetItem(row); }}
          onOpenOrder={(id) => setSheetOrderId(id)}
          onShowInList={goOrder}
          onEdit={goEditOrder} />
      )}
    </div>
  );
}

/* ================= Overview ================= */

function Overview({ c, delta, reviewCount, goView, goOrder }) {
  const s = c.stats;
  const recent = [...c.data.orders].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 5);
  if (c.data.orders.length === 0) return <Empty syncing={c.syncing} />;
  return (
    <div className="space-y-4">
      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-lg p-4 bg-gradient-to-br from-stone-900 to-stone-800 text-white">
          <div className="text-[10px] uppercase tracking-widest text-stone-400 font-semibold">Total charged</div>
          <div className="mono text-2xl font-semibold text-orange-300 mt-1">{fmt(s.spent)}</div>
          {delta && <div className="text-[11.5px] font-semibold mt-0.5 text-stone-300">{delta.diff >= 0 ? "▲" : "▼"} {fmt(Math.abs(delta.diff))} vs last month</div>}
          <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="w-full h-7 mt-2">
            <polyline points={sparkPoints(s.monthData)} fill="none" stroke="#fb923c" strokeWidth="2" />
          </svg>
        </div>
        <Kpi label="Discounts captured" value={fmt(s.saved)} valueCls="text-emerald-700" sub={`${pct(s.avgDisc)} avg off list`} spark={sparkPoints(s.monthData)} sparkColor="#059669" />
        <Kpi label="Avg $ / item" value={fmt(s.avgPerItem)} sub={`${s.totalQty} items total`} spark={sparkPoints(s.monthData)} sparkColor="#a8a29e" />
        <Kpi label="In transit" value={String(c.inTransit.length)} valueCls="text-blue-700" sub={c.inTransit.length ? "see arriving soon ↓" : "nothing on the way"} spark="" />
      </div>

      {reviewCount > 0 && (
        <button onClick={() => goView("review")}
          className="w-full text-left bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 text-sm text-amber-800 hover:bg-amber-100 transition-colors">
          <AlertTriangle size={14} className="inline mr-1.5 -mt-0.5" />
          <b>{reviewCount}</b> thing{reviewCount === 1 ? "" : "s"} could use a look — estimated prices, empty orders, or failed emails. <b>Review queue →</b>
        </button>
      )}

      <div className="grid lg:grid-cols-5 gap-3">
        {/* Recent orders */}
        <div className="lg:col-span-3 bg-white border border-stone-200 rounded-lg overflow-hidden">
          <PanelHead title="Recent orders" action={<button onClick={() => goView("orders")} className="text-xs font-semibold text-blue-600 hover:text-blue-500">All orders →</button>} />
          <table className="w-full text-sm">
            <tbody>
              {recent.map((o) => (
                <tr key={o.id} className="border-b border-stone-100 last:border-0 hover:bg-orange-50/40 cursor-pointer" title="Open this order" onClick={() => goOrder(o.id)}>
                  <td className="py-2 px-4 mono text-[12.5px] font-semibold">{o.id}</td>
                  <td className="py-2 pr-2 text-xs text-stone-500 whitespace-nowrap">{(o.date || "").slice(0, 10)}</td>
                  <td className="py-2 pr-2"><StatusChip s={o.status || "ordered"} /></td>
                  <td className="py-2 pr-2 text-xs text-stone-500">{(o.items || []).length} item{(o.items || []).length === 1 ? "" : "s"}</td>
                  <td className="py-2 pr-4 mono text-right font-semibold">{fmt(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Arriving soon */}
        <div className="lg:col-span-2 bg-white border border-stone-200 rounded-lg overflow-hidden">
          <PanelHead title="Arriving soon" />
          {c.inTransit.length === 0 ? (
            <div className="px-4 py-6 text-sm text-stone-400 text-center">Nothing in transit right now.</div>
          ) : (
            <div className="divide-y divide-stone-100">
              {[...c.inTransit]
                .sort((a, b) => (etaEndDate(a.eta) || "9999").localeCompare(etaEndDate(b.eta) || "9999"))
                .slice(0, 6).map((o) => {
                  const first = annotateThumbs(o.items || [])[0];
                  const info = carrierInfoFor(c.carrier, o);
                  const liveEta = carrierEtaText(info);
                  const end = etaEndDate(liveEta || o.eta);
                  const overdue = !liveEta && end && end < new Date().toISOString().slice(0, 10);
                  return (
                    <div key={o.id} className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-orange-50/40 transition-colors"
                      title="Open this order" onClick={() => goOrder(o.id)}>
                      <span onClick={(e) => e.stopPropagation()}>
                        {first ? <CropThumb url={first.thumbUrl} y={first.thumbY} rows={first.thumbRows} idx={first.thumbIdx} trustY={first.thumbTrustY} size={34} onClick={() => first.thumbUrl && c.setLightbox(first.thumbUrl)} /> : <Truck size={18} className="text-blue-500" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium truncate">{first?.name || o.id}</div>
                        <div className="mono text-[10.5px] text-stone-400">{o.id}{(o.items || []).length > 1 ? ` · +${o.items.length - 1} more` : ""}</div>
                      </div>
                      <div className="text-right">
                        {info?.status === "Delivered"
                          ? <div className="text-[11.5px] font-semibold text-amber-600">✓ delivered per carrier</div>
                          : liveEta
                            ? <div className="text-[11.5px] font-semibold text-blue-700" title={info?.eventDesc || undefined}>
                                est. {liveEta}
                                {info?.status && CARRIER_STATUS_LABEL[info.status] && <span className="block text-[10px] font-medium text-stone-400">{CARRIER_STATUS_LABEL[info.status]}</span>}
                              </div>
                            : o.eta
                              ? <div className={`text-[11.5px] font-semibold ${overdue ? "text-amber-600" : "text-blue-700"}`}>{overdue ? "was due" : "est."} {o.eta}</div>
                              : <div className="text-[11px] text-stone-400">ordered {(o.date || "").slice(5, 10)}</div>}
                        <button
                          onClick={(e) => { e.stopPropagation(); if (o.tracking?.url) window.open(o.tracking.url, "_blank"); else c.openOrderPage(o); }}
                          title={o.tracking?.url ? `Open ${o.tracking.carrier || "carrier"} tracking${o.tracking.number ? ` (${o.tracking.number})` : ""}` : "Open order details on Temu"}
                          className="text-[11px] font-semibold text-blue-600 hover:text-blue-500 inline-flex items-center gap-0.5">
                          {o.tracking?.carrier ? `Track · ${o.tracking.carrier}` : "Track"} <ExternalLink size={10} />
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>

      {/* Spend by category bars */}
      <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
        <PanelHead title="Spend by category" action={<button onClick={() => goView("analytics")} className="text-xs font-semibold text-blue-600 hover:text-blue-500">Analytics →</button>} />
        <div className="py-2">
          {s.catData.slice(0, 6).map((cat, i) => {
            const max = s.catData[0]?.spend || 1;
            return (
              <div key={cat.name} className="grid grid-cols-[110px_1fr_70px] items-center gap-3 px-4 py-1.5 text-[13px]">
                <span>{cat.name}</span>
                <div className="h-2.5 rounded-full bg-gradient-to-r from-orange-600 to-orange-400" style={{ width: `${(cat.spend / max) * 100}%`, opacity: 1 - i * 0.09 }} />
                <span className="mono text-xs text-right text-stone-500">{fmt(cat.spend)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, valueCls = "", sub, spark, sparkColor }) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg p-4">
      <div className="text-[10px] uppercase tracking-widest text-stone-500 font-semibold">{label}</div>
      <div className={`mono text-2xl font-semibold mt-1 ${valueCls}`}>{value}</div>
      {sub && <div className="text-[11.5px] text-stone-500 mt-0.5">{sub}</div>}
      {spark ? (
        <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="w-full h-7 mt-2">
          <polyline points={spark} fill="none" stroke={sparkColor} strokeWidth="2" />
        </svg>
      ) : <div className="h-7 mt-2" />}
    </div>
  );
}

/* "Fix all" — one click runs Try real prices for every order with an
   estimated item, with a cost estimate shown up front (see
   lib/anthropic.js → estimateCostPerCall: self-corrects from this
   browser's own past fixEstimatedPrices calls once there's history). */
function FixAllButton({ c, estimatedItems }) {
  const orderIds = useMemo(() => [...new Set(estimatedItems.map((it) => it.orderId))], [estimatedItems]);
  const cost = useMemo(() => estimateCostPerCall("fixPrices"), [estimatedItems]);
  const total = cost.perCall * orderIds.length;
  if (!orderIds.length) return null;
  return (
    <button onClick={c.fixAllEstimatedPrices} disabled={c.syncing}
      title={cost.sampleSize > 0
        ? `Estimated from your last ${cost.sampleSize} price fix(es) on this device`
        : "Rough estimate (no fix history yet on this device) — refines automatically after your first fix"}
      className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 border border-emerald-400 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1 rounded-md transition-colors disabled:opacity-40">
      Fix all {orderIds.length} order{orderIds.length === 1 ? "" : "s"}
      <span className="mono font-normal">(~{fmt(total)}, ~{fmt(cost.perCall)}/order)</span>
    </button>
  );
}

function PanelHead({ title, action }) {
  return (
    <div className="flex items-center px-4 py-2.5 border-b border-stone-200">
      <h2 className="disp text-[13px] font-extrabold uppercase tracking-wide text-stone-700">{title}</h2>
      <div className="ml-auto">{action}</div>
    </div>
  );
}

/* ================= Orders ================= */

const ORDER_SORTS = [["date", "Date"], ["total", "Total"], ["status", "Status"], ["id", "PO"]];

function OrdersView({ c, orders, expanded, setExpanded, goOrder, openItem, orderStatusFilter, setOrderStatusFilter, orderSort, setOrderSort, hasQuery }) {
  if (c.data.orders.length === 0) return <Empty syncing={c.syncing} />;
  return (
    <div className="space-y-3">
      <div className="bg-white border border-stone-200 rounded-lg p-3 flex flex-wrap gap-2 items-center">
        <select value={orderStatusFilter} onChange={(e) => setOrderStatusFilter(e.target.value)}
          className="border border-stone-300 rounded-sm text-sm py-1.5 px-2 bg-white">
          <option value="All">All statuses</option>
          <option value="ordered">Ordered</option>
          <option value="shipped">Shipped</option>
          <option value="delivered">Delivered</option>
          <option value="cancelled">Cancelled</option>
          <option value="returned">Returned</option>
        </select>
        <span className="text-xs text-stone-400">Sort</span>
        <select value={orderSort.key} onChange={(e) => setOrderSort((s) => ({ ...s, key: e.target.value }))}
          className="border border-stone-300 rounded-sm text-sm py-1.5 px-2 bg-white">
          {ORDER_SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <button onClick={() => setOrderSort((s) => ({ ...s, dir: -s.dir }))}
          className="border border-stone-300 rounded-sm text-sm py-1.5 px-2 bg-white text-stone-600 hover:text-stone-900"
          title="Reverse sort direction">
          {orderSort.dir === 1 ? "↑ asc" : "↓ desc"}
        </button>
        <span className="mono text-xs text-stone-500 ml-auto">
          {orders.length} order{orders.length === 1 ? "" : "s"} · charged {fmt(orders.reduce((s, o) => s + (o.total || 0), 0))}
        </span>
      </div>
      {orders.length === 0 ? (
        <div className="text-center text-stone-400 py-10 text-sm bg-white border border-stone-200 rounded-lg">
          No orders match{hasQuery ? " your search" : " this filter"}.
        </div>
      ) : (
      <div className="space-y-2">
      {orders.map((o) => (
        <div key={o.id} id={`d-order-${o.id}`} className={`border rounded-lg bg-white ${isActiveStatus(o.status) ? "border-stone-200" : "border-stone-200 bg-stone-50/60"}`}>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 cursor-pointer hover:bg-stone-50 rounded-lg"
            onClick={() => setExpanded((e) => ({ ...e, [o.id]: !e[o.id] }))}>
            {expanded[o.id] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <button
              onClick={(e) => { e.stopPropagation(); goOrder(o.id); }}
              title="Open order details (popup)"
              className={`mono text-sm font-semibold hover:text-orange-700 hover:underline underline-offset-2 transition-colors ${!isActiveStatus(o.status) ? "line-through text-stone-400" : ""}`}>
              {o.id}
            </button>
            <span className="text-xs text-stone-500">{(o.date || "").slice(0, 10)}</span>
            <StatusChip s={o.status || "ordered"} />
            {o.manualEdit && <span className="text-[10px] text-blue-500 border border-blue-300 rounded-sm px-1">edited</span>}
            {o.status === "shipped" && o.eta && <span className="text-[11px] text-blue-600 font-semibold">est. {o.eta}</span>}
            <span className="ml-auto mono text-sm">
              {fmt(o.total)}{o.discountFactor != null && o.discountFactor < 1 && <span className="text-emerald-700 text-xs"> ({pct(1 - o.discountFactor)} off)</span>}
            </span>
            <button className="p-1 text-stone-400 hover:text-orange-600 transition-colors"
              onClick={(e) => { e.stopPropagation(); c.openOrderPage(o); }}
              title="Open order details on Temu in a new tab">
              <ExternalLink size={14} />
            </button>
            <button className="p-1 text-stone-400 hover:text-emerald-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              disabled={c.syncing}
              onClick={(e) => { e.stopPropagation(); if (!c.syncing && confirm(`Re-read ${o.id} from its email? This restores any deleted items and replaces hand-edits with a fresh parse (status is kept).`)) c.rereadOrder(o); }}
              title={c.syncing ? "Wait for the sync to finish" : "Re-read this order from its email (restores deleted/missing items)"}>
              <RotateCcw size={14} />
            </button>
            <button className="p-1 text-stone-400 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              disabled={c.syncing}
              onClick={(e) => { e.stopPropagation(); if (!c.syncing) { c.startEdit(o); setExpanded((x) => ({ ...x, [o.id]: true })); } }}
              title={c.syncing ? "Wait for the sync to finish" : "Edit this order"}>
              <Pencil size={14} />
            </button>
            <button className="p-1 text-stone-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              disabled={c.syncing}
              title={c.syncing ? "Wait for the sync to finish" : "Remove this order"}
              onClick={(e) => { e.stopPropagation(); if (!c.syncing && confirm(`Remove ${o.id}?`)) c.deleteOrder(o.id); }}>
              <Trash2 size={14} />
            </button>
          </div>
          {expanded[o.id] && (
            <div className="border-t border-stone-200 px-3 py-2">
              {c.editingId === o.id && c.editDraft ? (
                <EditForm c={c} />
              ) : (
                <>
                  <table className="w-full text-sm">
                    <tbody>
                      {annotateThumbs(o.items || []).map((it, i) => (
                        <tr key={i} className="border-b border-stone-100 last:border-0 hover:bg-orange-50/40 cursor-pointer transition-colors"
                          title="Open item details"
                          onClick={() => openItem({ ...it, orderId: o.id, date: o.date, status: o.status || "ordered", itemIdx: i })}>
                          <td className="py-1 pr-2" onClick={(e) => e.stopPropagation()}>
                            <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={c.thumbSize} onClick={() => it.thumbUrl && c.setLightbox(it.thumbUrl)} />
                          </td>
                          <td className="py-1 pr-2">{it.name} {it.qty > 1 && <span className="text-stone-400">×{it.qty}</span>}
                            <div className="text-[11px] text-stone-400">{it.category}</div></td>
                          <td className="py-1 mono text-right text-stone-400 line-through">{it.estimated || it.listedUnknown ? "" : fmt(it.listed)}</td>
                          <td className="py-1 mono text-right font-semibold pl-3">
                            {fmt(it.paid)}
                            {it.estimated && <span className="text-amber-500 ml-0.5" title="Estimated — Temu's split-order email doesn't include a per-item price, so this is the order total split evenly across its items.">≈</span>}
                            {!it.estimated && it.listedUnknown && <span className="text-stone-400 ml-0.5" title="Paid amount is exact — the pre-discount list price wasn't shown.">🏷</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mono text-[11px] text-stone-500 mt-2 flex flex-wrap gap-x-4">
                    <span>subtotal {fmt(o.subtotal)}</span>
                    <span>discount −{fmt(o.discount)}</span>
                    <span>ship {fmt(o.shipping)}</span>
                    <span>tax {fmt(o.tax)}</span>
                    <span className="font-semibold text-stone-800">charged {fmt(o.total)}</span>
                  </div>
                  <RelatedOrders c={c} order={o} goOrder={goOrder} />
                  {o.images?.length > 0 && (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {o.images.map((im, i) => (
                        <img key={i} src={im} alt="" className="h-12 rounded-sm border border-stone-200 cursor-pointer" onClick={() => c.setLightbox(im)} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      ))}
      </div>
      )}
    </div>
  );
}

/* "Also from this email" chips — Temu split emails create several orders
   from one message; this makes the family navigable in one click. */
function RelatedOrders({ c, order, goOrder }) {
  const sibs = siblingOrders(c.data.orders, order);
  if (!sibs.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2 pt-2 border-t border-stone-100">
      <span className="text-[10.5px] text-stone-400 uppercase tracking-wide">Same email:</span>
      {sibs.map((s) => (
        <button key={s.id} onClick={(e) => { e.stopPropagation(); goOrder(s.id); }}
          title={`${(s.items || []).length} item(s) · ${fmt(s.total)} · ${s.status || "ordered"}`}
          className="mono text-[11px] border border-stone-300 rounded-full px-2 py-0.5 text-stone-600 hover:border-orange-400 hover:text-orange-700 transition-colors">
          {s.id}
        </button>
      ))}
    </div>
  );
}

function EditForm({ c }) {
  const d = c.editDraft;
  const setD = c.setEditDraft;
  const field = (label, key, type = "number") => (
    <label className="flex flex-col gap-0.5">{label}
      <input type={type} step="0.01" value={d[key] ?? ""}
        onChange={(e) => setD((x) => ({ ...x, [key]: e.target.value }))}
        className="border border-stone-300 rounded-sm px-1 py-1" />
    </label>
  );
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <label className="flex flex-col gap-0.5">Status
          <select value={d.status || "ordered"}
            onChange={(e) => setD((x) => ({ ...x, status: e.target.value }))}
            className="border border-stone-300 rounded-sm px-1 py-1">
            {Object.keys(STATUS_META).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
          </select>
        </label>
        {field("Date", "date", "date")}
        {field("Subtotal", "subtotal")}
        {field("Discount", "discount")}
        {field("Shipping", "shipping")}
        {field("Tax", "tax")}
        {field("Total", "total")}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-stone-500">
            <th className="text-left py-1">Item</th>
            <th className="text-left py-1">Category</th>
            <th className="text-right py-1">Qty</th>
            <th className="text-right py-1">Listed</th>
            <th className="text-right py-1">Paid</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {d.items.map((it, i) => (
            <tr key={i} className="border-b border-stone-100">
              <td className="py-1 pr-1">
                <input value={it.name || ""}
                  onChange={(e) => setD((x) => { const items = [...x.items]; items[i] = { ...items[i], name: e.target.value }; return { ...x, items }; })}
                  className="w-full border border-stone-300 rounded-sm px-1 py-0.5" />
              </td>
              <td className="py-1 pr-1">
                <select value={it.category || "Other"}
                  onChange={(e) => setD((x) => { const items = [...x.items]; items[i] = { ...items[i], category: e.target.value }; return { ...x, items }; })}
                  className="border border-stone-300 rounded-sm px-1 py-0.5">
                  {CATEGORIES.map((cat) => <option key={cat}>{cat}</option>)}
                </select>
              </td>
              <td className="py-1 pr-1 text-right">
                <input type="number" min="1" value={it.qty ?? 1}
                  onChange={(e) => setD((x) => { const items = [...x.items]; items[i] = { ...items[i], qty: e.target.value }; return { ...x, items }; })}
                  className="w-14 border border-stone-300 rounded-sm px-1 py-0.5 text-right" />
              </td>
              <td className="py-1 pr-1 text-right">
                <input type="number" step="0.01" value={it.listed ?? ""}
                  onChange={(e) => setD((x) => { const items = [...x.items]; items[i] = { ...items[i], listed: e.target.value }; return { ...x, items }; })}
                  className="w-16 border border-stone-300 rounded-sm px-1 py-0.5 text-right" />
              </td>
              <td className="py-1 pr-1 text-right">
                <input type="number" step="0.01" value={it.paid ?? ""}
                  onChange={(e) => setD((x) => { const items = [...x.items]; items[i] = { ...items[i], paid: e.target.value }; return { ...x, items }; })}
                  className="w-16 border border-stone-300 rounded-sm px-1 py-0.5 text-right" />
              </td>
              <td className="py-1 text-right">
                <button onClick={() => setD((x) => ({ ...x, items: x.items.filter((_, idx) => idx !== i) }))}
                  className="text-stone-400 hover:text-red-600" title="Remove this item">
                  <X size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-2">
        <button onClick={c.saveEdit}
          className="inline-flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 py-1.5 rounded-sm transition-colors">
          <Save size={13} /> Save
        </button>
        <button onClick={c.cancelEdit}
          className="text-stone-500 hover:text-stone-800 text-xs font-bold px-3 py-1.5 border border-stone-300 rounded-sm transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ================= Items ================= */

function ItemsView({ c, filteredItems, th, catFilter, setCatFilter, statusFilter, setStatusFilter, openItem, goOrder }) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg p-3">
      <div className="flex flex-wrap gap-2 mb-3 items-center">
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
          className="border border-stone-300 rounded-sm text-sm py-1.5 px-2 bg-white">
          <option>All</option>{CATEGORIES.map((cat) => <option key={cat}>{cat}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-stone-300 rounded-sm text-sm py-1.5 px-2 bg-white">
          <option value="All">All (active)</option>
          <option value="ordered">Ordered</option>
          <option value="shipped">Shipped</option>
          <option value="delivered">Delivered</option>
          <option value="cancelled">Cancelled</option>
          <option value="returned">Returned</option>
        </select>
        <span className="mono text-xs text-stone-500 ml-auto">
          {filteredItems.length} items · paid {fmt(filteredItems.reduce((s, i) => s + (i.paid || 0) * (i.qty || 1), 0))}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b-2 border-stone-300">
            <tr>
              <th></th>
              {th("Item", "name")}{th("Category", "category")}{th("Listed", "listed", true)}{th("Paid", "paid", true)}{th("Disc", "discountPct", true)}{th("Date", "date")}{th("Status", "status")}
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((it, i) => (
              <tr key={i} className="border-b border-stone-100 hover:bg-orange-50/40 cursor-pointer transition-colors"
                title="Open item details" onClick={() => openItem(it)}>
                <td className="py-1.5 pr-1" onClick={(e) => e.stopPropagation()}>
                  <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={c.thumbSize} onClick={() => it.thumbUrl && c.setLightbox(it.thumbUrl)} />
                </td>
                <td className="py-1.5 pr-2">{it.name}{it.qty > 1 && <span className="text-stone-400"> ×{it.qty}</span>}
                  <div>
                    <button onClick={(e) => { e.stopPropagation(); goOrder(it.orderId); }}
                      title="Jump to this order"
                      className="mono text-[10px] text-stone-400 hover:text-blue-600 hover:underline underline-offset-2 transition-colors">
                      {it.orderId}
                    </button>
                  </div></td>
                <td className="py-1.5 pr-2 text-xs text-stone-500">{it.category}</td>
                <td className="py-1.5 mono text-right text-stone-400 line-through">{it.estimated || it.listedUnknown ? "" : fmt(it.listed)}</td>
                <td className="py-1.5 mono text-right font-semibold">
                  {fmt(it.paid)}
                  {it.estimated && <span className="text-amber-500 ml-0.5" title="Estimated — split-order emails don't include per-item prices.">≈</span>}
                  {!it.estimated && it.listedUnknown && <span className="text-stone-400 ml-0.5" title="Paid amount is exact (only item in this order) — the pre-discount list price wasn't shown.">🏷</span>}
                </td>
                <td className="py-1.5 mono text-right text-emerald-700 text-xs">{pct(it.discountPct)}</td>
                <td className="py-1.5 px-2 text-xs whitespace-nowrap">{(it.date || "").slice(0, 10)}</td>
                <td className="py-1.5"><StatusChip s={it.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredItems.length === 0 && <div className="text-center text-stone-400 py-10 text-sm">No items match.</div>}
      </div>
    </div>
  );
}

/* ================= Needs review ================= */

function ReviewView({ c, goEditOrder }) {
  const { estimatedItems, emptyOrders, listPriceUnknownItems } = c.review;
  // listPriceUnknownItems doesn't count toward the urgent "Needs review"
  // badge (see reviewCount in the parent) — its paid amount is exact, only
  // the list price is unknown — but it still needs to show/hide this page's
  // own "All clear" state correctly when it's the only non-empty bucket.
  const nothing = !estimatedItems.length && !emptyOrders.length && !c.failedEmails.length && !c.unmatchedStatus.length && !listPriceUnknownItems.length;
  if (nothing) {
    return (
      <div className="text-center py-16 text-stone-400 border-2 border-dashed border-stone-200 rounded-lg bg-white">
        <div className="text-3xl mb-2">✓</div>
        <div className="disp font-bold text-stone-500">All clear</div>
        <div className="text-sm mt-1">No estimated prices, empty orders, or failed emails.</div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {c.unmatchedStatus.length > 0 && (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <PanelHead title={`Status emails with no matching order (${c.unmatchedStatus.length})`} />
          <div className="px-4 py-2 text-[12.5px] text-stone-500 border-b border-stone-100">
            Temu sent a shipped/delivered/cancelled email but the order it belongs to isn't in the store — usually a split-email sub-order the parser missed. <b>Find &amp; import</b> hunts down its confirmation email and parses just that order.
          </div>
          <div className="divide-y divide-stone-100">
            {c.unmatchedStatus.map((u) => (
              <UnmatchedStatusRow key={u.id} u={u} c={c} />
            ))}
          </div>
        </div>
      )}

      {c.failedEmails.length > 0 && (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <PanelHead title={`Failed emails (${c.failedEmails.length})`}
            action={<button onClick={c.retryFailedEmails} disabled={c.syncing}
              className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 border border-amber-400 bg-amber-50 hover:bg-amber-100 px-2.5 py-1 rounded-md transition-colors">
              <RotateCcw size={12} /> Retry all
            </button>} />
          <div className="px-4 py-3 text-sm text-stone-600">
            These emails errored out before an order could be created (network hiccups, timeouts, bad vision replies). Retry re-reads just these.
            <div className="mono text-[11px] text-stone-400 mt-2">{c.failedEmails.map((e) => e.id.slice(0, 12)).join(" · ")}</div>
          </div>
        </div>
      )}

      {estimatedItems.length > 0 && (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <PanelHead title={`Estimated prices (${estimatedItems.length})`} action={<FixAllButton c={c} estimatedItems={estimatedItems} />} />
          <div className="px-4 py-2 text-[12.5px] text-stone-500 border-b border-stone-100">
            From split-order emails with no per-item price — the order total was split evenly. <b>Try real prices</b> re-reads a shipped/delivered email for that order, which carries the real priced receipt (1 vision call); <b>Fix price</b> edits by hand.
          </div>
          <div className="divide-y divide-stone-100">
            {estimatedItems.map((it, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2">
                <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={36} onClick={() => it.thumbUrl && c.setLightbox(it.thumbUrl)} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate">{it.name}</div>
                  <div className="mono text-[10.5px] text-stone-400">{it.orderId} · paid ≈{fmt(it.paid)}</div>
                </div>
                <button onClick={() => c.fixEstimatedPrices(it.orderId)} disabled={c.syncing}
                  className="text-xs font-semibold text-emerald-600 hover:text-emerald-500 whitespace-nowrap disabled:opacity-40">
                  Try real prices
                </button>
                <button onClick={() => goEditOrder(it.orderId)} disabled={c.syncing}
                  className="text-xs font-semibold text-blue-600 hover:text-blue-500 whitespace-nowrap disabled:opacity-40">
                  <Pencil size={11} className="inline -mt-0.5 mr-1" />Fix price
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {listPriceUnknownItems.length > 0 && (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <PanelHead title={`List price unknown (${listPriceUnknownItems.length})`} />
          <div className="px-4 py-2 text-[12.5px] text-stone-500 border-b border-stone-100">
            Single-item orders from split confirmations — the amount paid is exact (the whole order total belongs to this one item), only the pre-discount list price was never shown. Not urgent; fix it if you want the discount % to display.
          </div>
          <div className="divide-y divide-stone-100">
            {listPriceUnknownItems.map((it, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2">
                <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={36} onClick={() => it.thumbUrl && c.setLightbox(it.thumbUrl)} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate">{it.name}</div>
                  <div className="mono text-[10.5px] text-stone-400">{it.orderId} · paid {fmt(it.paid)} (exact)</div>
                </div>
                <button onClick={() => c.fixEstimatedPrices(it.orderId)} disabled={c.syncing}
                  className="text-xs font-semibold text-emerald-600 hover:text-emerald-500 whitespace-nowrap disabled:opacity-40">
                  Try real prices
                </button>
                <button onClick={() => goEditOrder(it.orderId)} disabled={c.syncing}
                  className="text-xs font-semibold text-blue-600 hover:text-blue-500 whitespace-nowrap disabled:opacity-40">
                  <Pencil size={11} className="inline -mt-0.5 mr-1" />Fix price
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {emptyOrders.length > 0 && (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <PanelHead title={`Orders with no items (${emptyOrders.length})`}
            action={<button onClick={() => c.sync(false, { wide: true })} disabled={c.syncing}
              className="text-xs font-bold text-blue-600 hover:text-blue-500">Reconcile now →</button>} />
          <div className="px-4 py-3 text-sm text-stone-600">
            Usually a truncated vision response. These are retried automatically on every sync.
            <div className="mono text-[11px] text-stone-400 mt-2">{emptyOrders.map((o) => o.id).join(" · ")}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* One row of the "Status emails with no matching order" queue. The Gmail
   link deep-links to the EXACT message (Gmail's #all/<messageId> permalink
   works for any hex message id, regardless of label/folder) instead of a
   keyword search — that way it opens right on the email in question rather
   than a results list. When no PO could be read from the email body (oid is
   null), there's no PO to hand importMissingOrder, so instead of hiding the
   row with nothing actionable, offer a manual entry: open the email via the
   link above, read the PO off it, paste it in, and re-use the same
   find-&-import flow. */
function UnmatchedStatusRow({ u, c }) {
  const [manualPo, setManualPo] = useState("");
  const gmailLink = `https://mail.google.com/mail/u/0/#all/${u.id}`;
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-[13px] flex-wrap">
      <StatusChip s={u.kind} />
      <span className="mono font-semibold">{u.oid || "(no PO readable)"}</span>
      {!u.oid && u.trackingNumber && (
        <span className="mono text-[11px] text-stone-400" title="Tracking number found in the email, but it doesn't match any stored order yet — its 'shipped' email may not have synced.">
          tracking {u.trackingNumber}
        </span>
      )}
      <span className="text-[11px] text-stone-400">{u.date || ""}</span>
      <span className="ml-auto flex items-center gap-2">
        {u.oid ? (
          <button onClick={() => c.importMissingOrder(u.oid)} disabled={c.syncing}
            className="text-xs font-bold text-blue-600 hover:text-blue-500 disabled:opacity-40">
            Find &amp; import
          </button>
        ) : (
          <>
            <input
              value={manualPo}
              onChange={(e) => setManualPo(e.target.value)}
              placeholder="Paste PO from email…"
              className="text-xs mono px-2 py-1 border border-stone-300 rounded-md w-40 focus:outline-none focus:border-blue-400"
            />
            <button
              onClick={() => c.importMissingOrder(manualPo.trim())}
              disabled={c.syncing || !manualPo.trim()}
              className="text-xs font-bold text-blue-600 hover:text-blue-500 disabled:opacity-40 whitespace-nowrap">
              Find &amp; import
            </button>
          </>
        )}
        <a href={gmailLink} target="_blank" rel="noreferrer"
          className="text-xs font-semibold text-stone-400 hover:text-stone-600 inline-flex items-center gap-0.5 whitespace-nowrap">
          Open email <ExternalLink size={10} />
        </a>
      </span>
    </div>
  );
}
