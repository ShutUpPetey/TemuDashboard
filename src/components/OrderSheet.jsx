import React from "react";
import { ExternalLink, Pencil, RotateCcw, ReceiptText } from "lucide-react";
import { fmt, pct, StatusChip, CropThumb, annotateThumbs, isActiveStatus, carrierInfoFor, carrierEtaText, CARRIER_STATUS_LABEL } from "./shared";
import { siblingOrders } from "../lib/derive";

/* ============================================================
   Order detail popup — the order-level counterpart to ItemSheet,
   shared by both shells (bottom sheet on mobile, modal on desktop).

   For split-email purchases it shows EVERY item from EVERY order
   in that email, grouped under per-order headers, so the whole
   purchase reads as one receipt. The header rows show which group
   belongs to which PO; tapping a sibling's header makes it the
   sheet's primary order (money breakdown + actions follow it).

   Callbacks: onOpenItem(itemRow) swaps to the item sheet;
   onOpenOrder(orderId) re-primaries the sheet on a sibling;
   onShowInList(orderId) jumps to the Orders view (expanded +
   scrolled); onEdit(orderId) opens the full edit form (desktop).
   ============================================================ */

export default function OrderSheet({ c, orderId, onClose, onOpenItem, onOpenOrder, onShowInList, onEdit, desktop = false }) {
  const order = c.data.orders.find((o) => o.id === orderId);
  if (!order) return null;
  const sibs = siblingOrders(c.data.orders, order);
  const family = [order, ...sibs];
  const familyTotal = family.reduce((s, o) => s + (o.total || 0), 0);
  const split = family.length > 1;
  const live = carrierInfoFor(c.carrier, order);
  const liveEta = carrierEtaText(live);

  return (
    <div className={`fixed inset-0 z-40 flex ${desktop ? "items-center" : "items-end"} justify-center bg-black/40 p-0 sm:p-4`} onClick={onClose}>
      <div
        className={`bg-white w-full max-w-md max-h-[88vh] overflow-y-auto ${desktop ? "rounded-2xl shadow-2xl" : "rounded-t-3xl"}`}
        onClick={(e) => e.stopPropagation()}>
        {!desktop && <div className="w-10 h-1 rounded-full bg-stone-300 mx-auto mt-2.5 mb-1" />}

        {/* header — the primary order */}
        <div className="px-5 pt-4 pb-3 bg-stone-50 border-b border-stone-100">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`mono text-[15px] font-bold ${!isActiveStatus(order.status) ? "line-through text-stone-400" : ""}`}>{order.id}</span>
            <StatusChip s={order.status || "ordered"} />
            {order.manualEdit && <span className="text-[10px] text-blue-500 border border-blue-300 rounded-sm px-1">edited</span>}
          </div>
          <div className="flex items-baseline gap-2 mt-1.5">
            <span className="mono text-xl font-semibold">{fmt(order.total)}</span>
            {order.discountFactor != null && order.discountFactor < 1 && (
              <span className="text-emerald-700 text-xs font-semibold">{pct(1 - order.discountFactor)} off list</span>
            )}
            <span className="text-[11.5px] text-stone-400 ml-auto">{(order.date || "").slice(0, 10)}</span>
          </div>
          {live ? (
            live.status === "Delivered" && order.status === "shipped" ? (
              <div className="text-[12px] text-amber-700 font-semibold mt-1">
                ✓ {live.provider || order.tracking?.carrier || "Carrier"} reports delivered — run a sync (or edit the status) to update this order.
              </div>
            ) : (
              <div className="text-[12px] text-blue-700 font-semibold mt-1" title={live.eventDesc || undefined}>
                {CARRIER_STATUS_LABEL[live.status] || live.status || "Tracking"}{liveEta ? ` · est. ${liveEta}` : ""}
                <span className="text-stone-400 font-medium"> · live via {live.provider || order.tracking?.carrier || "carrier"}</span>
              </div>
            )
          ) : (
            order.status === "shipped" && order.eta && (
              <div className="text-[12px] text-blue-700 font-semibold mt-1">Est. delivery {order.eta} <span className="text-stone-400 font-medium">(from email)</span></div>
            )
          )}
          {order.tracking?.url && (
            <button onClick={() => window.open(order.tracking.url, "_blank")}
              className="text-[12px] text-blue-600 hover:text-blue-500 font-semibold mt-1 inline-flex items-center gap-1 underline underline-offset-2">
              Track with {order.tracking.carrier || "carrier"}{order.tracking.number ? ` · ${order.tracking.number}` : ""} <ExternalLink size={11} />
            </button>
          )}
          {split && (
            <div className="text-[11px] font-bold uppercase tracking-wide text-orange-700 mt-1.5">
              Split purchase · {family.length} orders in one email · {fmt(familyTotal)} combined
            </div>
          )}
        </div>

        <div className="px-5 pt-3 pb-6">
          {/* every item in the purchase, grouped by order */}
          {family.map((o) => {
            const items = annotateThumbs(o.items || []);
            const primary = o.id === order.id;
            return (
              <div key={o.id} className={split ? "mt-2 first:mt-0" : ""}>
                {split && (
                  <button
                    disabled={primary}
                    onClick={() => onOpenOrder(o.id)}
                    title={primary ? undefined : "Focus this order (totals & actions follow it)"}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors ${primary ? "bg-orange-50 border border-orange-200" : "bg-stone-50 border border-stone-200 hover:border-orange-300"}`}>
                    <span className={`mono text-[12px] font-bold ${!isActiveStatus(o.status) ? "line-through text-stone-400" : ""}`}>{o.id}</span>
                    <StatusChip s={o.status || "ordered"} />
                    {primary
                      ? <span className="text-[9.5px] uppercase tracking-wide text-orange-600 font-bold">viewing</span>
                      : o.status === "shipped" && o.eta && <span className="text-[10px] text-blue-600 font-semibold">est. {o.eta}</span>}
                    <span className="mono text-[12.5px] font-semibold ml-auto">{fmt(o.total)}</span>
                    {!primary && <span className="text-stone-400">›</span>}
                  </button>
                )}
                <div className="divide-y divide-stone-50">
                  {items.map((it, i) => (
                    <button key={i}
                      onClick={() => onOpenItem({ ...it, orderId: o.id, date: o.date, status: o.status || "ordered", itemIdx: i })}
                      className="w-full flex items-center gap-2.5 py-1.5 px-1 text-left hover:bg-orange-50/40 rounded-md transition-colors">
                      <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={38} rounded="rounded-lg" />
                      <span className="min-w-0 flex-1 text-[13px]">{it.name} {it.qty > 1 && <span className="text-stone-400">×{it.qty}</span>}</span>
                      <span className="mono text-[13px] font-semibold">{fmt(it.paid)}{it.estimated && <span className="text-amber-500">≈</span>}</span>
                    </button>
                  ))}
                  {items.length === 0 && (
                    <div className="text-[12.5px] text-stone-400 py-2 px-1">No items parsed{primary ? " — try “Re-read from email” below." : "."}</div>
                  )}
                </div>
              </div>
            );
          })}

          {/* money — primary order */}
          <div className="mono text-[11px] text-stone-500 mt-2 pt-2 border-t border-stone-100 flex flex-wrap gap-x-4">
            {split && <span className="text-stone-400">{order.id}:</span>}
            <span>sub {fmt(order.subtotal)}</span>
            <span>disc −{fmt(order.discount)}</span>
            <span>ship {fmt(order.shipping)}</span>
            <span>tax {fmt(order.tax)}</span>
            <span className="font-semibold text-stone-800">charged {fmt(order.total)}</span>
          </div>

          {/* receipt images — primary order */}
          {order.images?.length > 0 && (
            <div className="flex gap-1 mt-3 flex-wrap">
              {order.images.map((im, i) => (
                <img key={i} src={im} alt="" className="h-12 rounded-sm border border-stone-200 cursor-pointer bg-white" onClick={() => c.setLightbox(im)} />
              ))}
            </div>
          )}

          {/* actions — primary order */}
          <div className="grid grid-cols-2 gap-2 mt-4">
            <button onClick={() => c.openOrderPage(order)}
              className="border-2 border-orange-200 bg-orange-50 rounded-xl py-2.5 text-sm font-bold text-orange-700">
              <ExternalLink size={13} className="inline -mt-0.5 mr-1" />Open in Temu
            </button>
            <button onClick={() => onShowInList(order.id)}
              className="border-2 border-stone-200 rounded-xl py-2.5 text-sm font-bold text-stone-600">
              <ReceiptText size={13} className="inline -mt-0.5 mr-1" />Show in Orders
            </button>
            {desktop && onEdit && (
              <button onClick={() => onEdit(order.id)} disabled={c.syncing}
                className="border-2 border-stone-200 rounded-xl py-2.5 text-sm font-bold text-stone-600 disabled:opacity-40">
                <Pencil size={13} className="inline -mt-0.5 mr-1" />Edit order
              </button>
            )}
            <button onClick={onClose}
              className={`bg-stone-900 text-white rounded-xl py-2.5 text-sm font-bold ${desktop && onEdit ? "" : "col-span-2"}`}>
              Done
            </button>
          </div>
          <button
            onClick={() => { if (!c.syncing && confirm(`Re-read ${order.id} from its email? Restores deleted items; keeps status.`)) { c.rereadOrder(order); onClose(); } }}
            disabled={c.syncing}
            className="w-full mt-2 text-center text-[12px] font-semibold text-stone-400 underline underline-offset-2 disabled:opacity-40">
            <RotateCcw size={11} className="inline -mt-0.5 mr-1" />Something missing? Re-read this order from its email
          </button>
        </div>
      </div>
    </div>
  );
}
