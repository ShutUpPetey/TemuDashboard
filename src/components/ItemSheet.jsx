import React, { useState } from "react";
import { Pencil, Save, ExternalLink, RotateCcw, ReceiptText } from "lucide-react";
import { CATEGORIES, fmt, StatusChip, CropThumb, carrierInfoFor, carrierEtaText } from "./shared";
import { siblingOrders } from "../lib/derive";

/* ============================================================
   Item detail sheet — the connective hub of the app, shared by
   both shells (bottom sheet on mobile, centered modal on desktop).
   From here you can: quick-edit the item, open the receipt image,
   open the order on temu.com, jump to the order in the Orders
   view, hop to related orders from the same split email, and
   force a re-read of the order from its source email.

   `it` is an annotated item row (allItems shape: orderId, date,
   status, itemIdx, thumb* fields). `onViewOrder(orderId)` is the
   shell's navigate-to-order function.
   ============================================================ */

export default function ItemSheet({ c, it, onClose, onViewOrder, desktop = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    name: it.name || "", category: it.category || "Other",
    qty: it.qty || 1, listed: it.listed ?? "", paid: it.paid ?? "",
  });
  const order = c.data.orders.find((o) => o.id === it.orderId);
  const sibs = order ? siblingOrders(c.data.orders, order) : [];
  const status = it.status || "ordered";
  const cancelled = status === "cancelled" || status === "returned";
  const steps = ["ordered", "shipped", "delivered"];
  const reached = steps.indexOf(status);
  const liveEta = carrierEtaText(carrierInfoFor(c.carrier, order));
  const bestEta = liveEta || order?.eta;

  const saveQuick = () => {
    c.updateItem(it.orderId, it.itemIdx, draft);
    setEditing(false);
    onClose();
  };

  return (
    <div className={`fixed inset-0 z-40 flex ${desktop ? "items-center" : "items-end"} justify-center bg-black/40 p-0 sm:p-4`} onClick={onClose}>
      <div
        className={`bg-white w-full max-w-md max-h-[88vh] overflow-y-auto ${desktop ? "rounded-2xl shadow-2xl" : "rounded-t-3xl"}`}
        onClick={(e) => e.stopPropagation()}>
        {!desktop && <div className="w-10 h-1 rounded-full bg-stone-300 mx-auto mt-2.5 mb-1" />}
        <div className="grid place-items-center py-3 bg-stone-50 border-b border-stone-100">
          <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={132} rounded="rounded-xl" onClick={() => it.thumbUrl && c.setLightbox(it.thumbUrl)} />
        </div>
        <div className="px-5 pt-3.5 pb-6">
          {editing ? (
            <div className="space-y-2.5">
              <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                className="w-full border border-stone-300 rounded-lg px-2.5 py-2 text-[15px] font-semibold" />
              <div className="grid grid-cols-3 gap-2 text-xs">
                <label className="flex flex-col gap-1 text-stone-500">Qty
                  <input type="number" min="1" value={draft.qty} onChange={(e) => setDraft((d) => ({ ...d, qty: e.target.value }))}
                    className="border border-stone-300 rounded-lg px-2 py-1.5 text-sm text-stone-900" />
                </label>
                <label className="flex flex-col gap-1 text-stone-500">Listed $
                  <input type="number" step="0.01" value={draft.listed} onChange={(e) => setDraft((d) => ({ ...d, listed: e.target.value }))}
                    className="border border-stone-300 rounded-lg px-2 py-1.5 text-sm text-stone-900" />
                </label>
                <label className="flex flex-col gap-1 text-stone-500">Paid $
                  <input type="number" step="0.01" value={draft.paid} onChange={(e) => setDraft((d) => ({ ...d, paid: e.target.value }))}
                    className="border border-stone-300 rounded-lg px-2 py-1.5 text-sm text-stone-900" />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-xs text-stone-500">Category
                <select value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                  className="border border-stone-300 rounded-lg px-2 py-2 text-sm bg-white text-stone-900">
                  {CATEGORIES.map((cat) => <option key={cat}>{cat}</option>)}
                </select>
              </label>
              <div className="flex gap-2 pt-1">
                <button onClick={saveQuick} disabled={c.syncing}
                  className="flex-1 bg-stone-900 text-white rounded-xl py-2.5 text-sm font-bold disabled:opacity-50">
                  <Save size={13} className="inline -mt-0.5 mr-1" />Save
                </button>
                <button onClick={() => setEditing(false)} className="flex-1 border-2 border-stone-200 rounded-xl py-2.5 text-sm font-bold text-stone-600">Cancel</button>
              </div>
              {c.syncing && <div className="text-[11px] text-amber-600">Editing is locked while a sync runs.</div>}
            </div>
          ) : (
            <>
              <h3 className="text-[16px] font-bold leading-snug">{it.name || "—"} {it.qty > 1 && <span className="text-stone-400 font-normal">×{it.qty}</span>}</h3>

              {cancelled ? (
                <div className="mt-3"><StatusChip s={status} /> <span className="text-[11.5px] text-stone-400 ml-1">excluded from totals</span></div>
              ) : (
                <div className="flex items-center mt-4 mb-1">
                  {steps.map((st, i) => (
                    <React.Fragment key={st}>
                      {i > 0 && <div className={`flex-1 h-0.5 ${i <= reached ? "bg-emerald-500" : "bg-stone-200"}`} />}
                      <div className="flex flex-col items-center gap-1 px-1">
                        <div className={`w-3 h-3 rounded-full ${i <= reached ? "bg-emerald-500" : "bg-stone-200"}`} />
                        <span className={`text-[9.5px] font-semibold ${i <= reached ? "text-emerald-600" : st === "delivered" && bestEta ? "text-blue-600" : "text-stone-400"}`}>
                          {st[0].toUpperCase() + st.slice(1)}
                          {st === "ordered" && it.date ? ` · ${it.date.slice(5, 10)}` : ""}
                          {st === "delivered" && reached < 2 && bestEta ? ` · est. ${bestEta}` : ""}
                        </span>
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              )}

              {status === "shipped" && order?.tracking?.url && (
                <button onClick={() => window.open(order.tracking.url, "_blank")}
                  className="w-full text-center text-[12px] font-semibold text-blue-600 hover:text-blue-500 mt-1.5">
                  Track with {order.tracking.carrier || "carrier"} ↗
                </button>
              )}

              <div className="mt-3 divide-y divide-dashed divide-stone-200 text-[13.5px]">
                <Row k="Order">
                  <button onClick={() => onViewOrder(it.orderId)}
                    className="mono text-blue-600 hover:text-blue-500 underline underline-offset-2">{it.orderId}</button>
                </Row>
                <Row k="Listed / paid">
                  <span className="mono">
                    {!it.estimated && it.listed != null && <s className="text-stone-400 mr-1.5">{fmt(it.listed)}</s>}
                    <b>{fmt(it.paid)}</b>
                    {it.estimated
                      ? <span className="text-amber-600 font-semibold ml-1.5">≈ estimated</span>
                      : it.discountPct > 0.005 && <span className="text-emerald-600 font-semibold ml-1.5">−{(it.discountPct * 100).toFixed(0)}%</span>}
                  </span>
                </Row>
                <Row k="Category"><span className="mono">{it.category}</span></Row>
                {order && (
                  <Row k="Order totals">
                    <span className="mono text-[12px]">{fmt(order.total)} charged{order.tax ? ` (incl. ${fmt(order.tax)} tax)` : ""} · {(order.items || []).length} item{(order.items || []).length === 1 ? "" : "s"}</span>
                  </Row>
                )}
                {sibs.length > 0 && (
                  <Row k="Same email">
                    <span className="flex flex-wrap gap-1 justify-end">
                      {sibs.map((s) => (
                        <button key={s.id} onClick={() => onViewOrder(s.id)}
                          title={`${(s.items || []).length} item(s) · ${fmt(s.total)} · ${s.status || "ordered"}`}
                          className="mono text-[11px] border border-stone-300 rounded-full px-2 py-0.5 text-stone-600 hover:border-orange-400 hover:text-orange-700 transition-colors">
                          {s.id}
                        </button>
                      ))}
                    </span>
                  </Row>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 mt-4">
                {order && (
                  <button onClick={() => c.openOrderPage(order)}
                    className="border-2 border-orange-200 bg-orange-50 rounded-xl py-2.5 text-sm font-bold text-orange-700">
                    <ExternalLink size={13} className="inline -mt-0.5 mr-1" />Open in Temu
                  </button>
                )}
                {it.thumbUrl && (
                  <button onClick={() => c.setLightbox(it.thumbUrl)}
                    className="border-2 border-stone-200 rounded-xl py-2.5 text-sm font-bold text-stone-600">🖼 Receipt</button>
                )}
                <button onClick={() => setEditing(true)} disabled={c.syncing}
                  className="border-2 border-stone-200 rounded-xl py-2.5 text-sm font-bold text-stone-600 disabled:opacity-40">
                  <Pencil size={13} className="inline -mt-0.5 mr-1" />Edit
                </button>
                <button onClick={() => onViewOrder(it.orderId)}
                  className="border-2 border-stone-200 rounded-xl py-2.5 text-sm font-bold text-stone-600">
                  <ReceiptText size={13} className="inline -mt-0.5 mr-1" />View order
                </button>
              </div>
              <button onClick={onClose} className="w-full mt-2 bg-stone-900 text-white rounded-xl py-2.5 text-sm font-bold">Done</button>
              {order && (
                <button
                  onClick={() => { if (!c.syncing && confirm(`Re-read ${order.id} from its email? Restores deleted items; keeps status.`)) { c.rereadOrder(order); onClose(); } }}
                  disabled={c.syncing}
                  className="w-full mt-2 text-center text-[12px] font-semibold text-stone-400 underline underline-offset-2 disabled:opacity-40">
                  <RotateCcw size={11} className="inline -mt-0.5 mr-1" />Something missing? Re-read this order from its email
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, children }) {
  return (
    <div className="flex justify-between items-baseline py-2 gap-3">
      <span className="text-stone-500 shrink-0">{k}</span>
      {children}
    </div>
  );
}
