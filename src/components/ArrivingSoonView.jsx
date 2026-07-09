import React, { useMemo } from "react";
import { AlertTriangle, Clock } from "lucide-react";
import { fmt, STATUS_META, CropThumb, Empty, CARRIER_STATUS_LABEL } from "./shared";
import { arrivingCalendar, isActiveStatus } from "../lib/derive";

/* ============================================================
   "Arriving Soon" — a 14-day forward calendar of expected
   deliveries, plus a guarantee-overdue alert and a strip for
   shipped items with no usable ETA at all. Same content on both
   shells (like AnalyticsView); `openItem` swaps in the shared
   ItemSheet, exactly the way ItemsView/OrdersView do.
   ============================================================ */
export default function ArrivingSoonView({ c, openItem }) {
  const { calendar, overdueItems, noEstimateItems } = useMemo(
    () => arrivingCalendar(c.data.orders, c.carrier, 14),
    [c.data.orders, c.carrier]
  );

  // "Non-delivered items with tracking" — the order carries a tracking
  // number (so it's actually shipped/in transit), not yet delivered/
  // cancelled/returned.
  const valueInTransit = useMemo(() => {
    let sum = 0;
    for (const o of c.data.orders) {
      const status = o.status || "ordered";
      if (status === "delivered" || !isActiveStatus(status) || !o.tracking?.number) continue;
      for (const it of o.items || []) sum += (it.paid || 0) * (it.qty || 1);
    }
    return sum;
  }, [c.data.orders]);

  const itemsArriving = calendar.reduce((s, day) => s + day.items.length, 0);
  const todayStr = calendar[0]?.date;

  if (c.data.orders.length === 0) return <Empty syncing={c.syncing} />;

  return (
    <div className="space-y-4">
      {/* Stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Items arriving" value={String(itemsArriving)} sub={`next ${calendar.length} days`} />
        <StatTile label="Orders in transit" value={String(c.inTransit.length)} valueCls="text-blue-700" />
        <StatTile label="Value in transit" value={fmt(valueInTransit)} valueCls="text-orange-700" />
        <StatTile
          label="Past guarantee"
          value={String(overdueItems.length)}
          valueCls={overdueItems.length ? "text-red-600" : ""}
          warn={overdueItems.length > 0}
        />
      </div>

      {/* Guarantee alert banner */}
      {overdueItems.length > 0 && (
        <div className="bg-red-50 border border-red-300 rounded-lg overflow-hidden">
          <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-red-200">
            <AlertTriangle size={14} className="text-red-600" />
            <h2 className="disp text-[13px] font-extrabold uppercase tracking-wide text-red-700">
              Past guaranteed delivery ({overdueItems.length})
            </h2>
          </div>
          <div className="divide-y divide-red-100">
            {overdueItems.map((it, i) => {
              const daysLate = Math.max(0, Math.round((Date.now() - new Date(it.expected + "T00:00:00")) / 86400000));
              return (
                <div key={i}
                  onClick={() => openItem(it)}
                  className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-red-100/50 transition-colors">
                  <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={40} onClick={(e) => { e.stopPropagation(); it.thumbUrl && c.setLightbox(it.thumbUrl); }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium truncate">{it.name || it.orderId}</div>
                    <div className="mono text-[10.5px] text-stone-400">{it.orderId} · {trackingActivityText(it.trackingInfo)}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[12px] font-bold text-red-700">{daysLate} day{daysLate === 1 ? "" : "s"} late</div>
                    <div className="text-[10px] text-stone-400">due {it.expected.slice(5)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 14-day calendar grid */}
      <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
        <div className="grid grid-cols-7">
          {calendar.map((day) => (
            <DayCell key={day.date} day={day} today={day.date === todayStr} openItem={openItem} setLightbox={c.setLightbox} />
          ))}
        </div>
      </div>

      {/* No estimate yet strip */}
      {noEstimateItems.length > 0 && (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-stone-200">
            <h2 className="disp text-[13px] font-extrabold uppercase tracking-wide text-stone-600">
              No estimate yet ({noEstimateItems.length})
            </h2>
            <div className="text-[11.5px] text-stone-400 mt-0.5">Shipped, but no carrier ETA and no parseable delivery date in the email — can't be placed on the calendar.</div>
          </div>
          <div className="flex flex-wrap gap-2 p-3">
            {noEstimateItems.map((it, i) => (
              <button key={i} onClick={() => openItem(it)}
                className="inline-flex items-center gap-2 bg-stone-50 border border-stone-200 rounded-full pl-1 pr-3 py-1 hover:border-orange-300 transition-colors max-w-full">
                <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={24} rounded="rounded-full" />
                <span className="text-[12px] font-medium truncate max-w-[160px]">{it.name || it.orderId}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, valueCls = "", sub, warn = false }) {
  return (
    <div className={`rounded-lg p-4 border ${warn ? "bg-red-50 border-red-300" : "bg-white border-stone-200"}`}>
      <div className={`text-[10px] uppercase tracking-widest font-semibold ${warn ? "text-red-500" : "text-stone-500"}`}>{label}</div>
      <div className={`mono text-2xl font-semibold mt-1 ${valueCls}`}>{value}</div>
      {sub && <div className="text-[11.5px] text-stone-500 mt-0.5">{sub}</div>}
    </div>
  );
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_PER_DAY = 4;

function DayCell({ day, today, openItem, setLightbox }) {
  const d = new Date(day.date + "T00:00:00");
  const items = day.items;
  const shown = items.slice(0, MAX_PER_DAY);
  const extra = items.length - shown.length;
  return (
    <div className={`border-b border-r border-stone-100 p-2 min-h-[136px] ${today ? "ring-2 ring-inset ring-orange-400 bg-orange-50/30" : ""}`}>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className={`text-[10px] font-semibold uppercase tracking-wide ${today ? "text-orange-600" : "text-stone-400"}`}>{DOW[d.getDay()]}</span>
        <span className={`mono text-[11px] ${today ? "text-orange-700 font-bold" : "text-stone-500"}`}>{day.date.slice(5)}</span>
      </div>
      {items.length === 0 ? (
        <div className="text-[10.5px] text-stone-300 italic pt-3 text-center select-none">—</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((it, i) => (
            <CalendarItem key={i} it={it} onOpen={() => openItem(it)} onZoom={() => it.thumbUrl && setLightbox(it.thumbUrl)} />
          ))}
          {extra > 0 && (
            <div className="flex items-center justify-center w-11 h-10 text-[10px] font-semibold text-stone-400">+{extra} more</div>
          )}
        </div>
      )}
    </div>
  );
}

/* Color cue reuses StatusChip's existing 3-color convention (stone/blue/
   emerald) rather than inventing a 4th for carrier "out for delivery" — that
   finer-grained state is instead surfaced via the tooltip. */
function CalendarItem({ it, onOpen, onZoom }) {
  const delivered = it.carrierStatus === "Delivered";
  const dotKey = delivered ? "delivered" : it.status;
  const dotCls = STATUS_META[dotKey]?.dot || STATUS_META.ordered.dot;
  const title = it.carrierStatus ? `${it.name} — ${CARRIER_STATUS_LABEL[it.carrierStatus] || it.carrierStatus}` : it.name;
  return (
    <button onClick={onOpen} title={title} className="flex flex-col items-center w-11 text-left">
      <div className="relative">
        <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={40} onClick={(e) => { e.stopPropagation(); onZoom(); }} />
        <span className={`absolute -bottom-1 -right-1 w-2.5 h-2.5 rounded-full border border-white ${dotCls}`} />
        {it.overdue && (
          <span className="absolute -top-1.5 -left-1.5 w-4 h-4 rounded-full bg-red-600 border-2 border-white grid place-items-center text-white text-[8px] font-bold" title="Overdue">!</span>
        )}
        {!it.overdue && it.stale && (
          <span className="absolute -top-1.5 -left-1.5 w-4 h-4 rounded-full bg-amber-500 border-2 border-white grid place-items-center text-white" title="Stale — carrier hasn't reported recently">
            <Clock size={9} />
          </span>
        )}
      </div>
      <span className="text-[9px] text-stone-500 leading-tight text-center truncate w-full mt-0.5">{it.name || "—"}</span>
    </button>
  );
}

function trackingActivityText(info) {
  if (!info) return "tracking never registered";
  if (info.eventTime) {
    const d = new Date(info.eventTime);
    if (!isNaN(d)) return `no scan since ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }
  return info.eventDesc || "no scan recorded";
}
