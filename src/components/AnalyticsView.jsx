import React from "react";
import { AreaChart, Area, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { fmt, pct, StatusChip, Empty, CropThumb } from "./shared";

/* Fixed categorical hue per status — matches STATUS_META's dot colors in
   shared.jsx, so a "shipped" bar here is the same blue as a shipped chip
   everywhere else in the app (identity follows the entity, never the rank
   in a given chart). */
const STATUS_HEX = { ordered: "#a8a29e", shipped: "#3b82f6", delivered: "#10b981", cancelled: "#ef4444", returned: "#78716c" };
// Fixed carrier order (never regenerated/cycled per filter) with an
// explicit "Other" fold-in past the 5th so the palette never grows unbounded.
const CARRIER_HEX = ["#ea580c", "#44403c", "#2563eb", "#059669", "#a855f7"];
const CARRIER_OTHER_HEX = "#a8a29e";

const monthLabel = (m) => {
  if (!m || m === "?") return "Unknown";
  const [y, mo] = m.split("-");
  const d = new Date(+y, +mo - 1, 1);
  return isNaN(d) ? m : d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
};

function HeroTile({ label, value, sub }) {
  return (
    <div className="rounded-lg p-5 bg-gradient-to-br from-stone-900 to-stone-800 text-white">
      <div className="text-[10px] uppercase tracking-widest text-stone-400 font-semibold">{label}</div>
      <div className="mono text-3xl font-bold text-orange-300 mt-1">{value}</div>
      {sub && <div className="text-[11.5px] text-stone-300 mt-1">{sub}</div>}
    </div>
  );
}

function MiniStat({ label, value, valueCls = "", sub }) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg p-4">
      <div className="text-[10px] uppercase tracking-widest text-stone-500 font-semibold">{label}</div>
      <div className={`mono text-2xl font-semibold mt-1 ${valueCls}`}>{value}</div>
      {sub && <div className="text-[11.5px] text-stone-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Callout({ label, primary, sub }) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-widest text-stone-500 font-semibold">{label}</div>
      <div className="text-sm font-semibold text-stone-800 mt-1 truncate" title={primary}>{primary}</div>
      {sub && <div className="text-[11.5px] text-stone-500 mt-0.5">{sub}</div>}
    </div>
  );
}

/* Analytics charts + tables — identical content on both shells.
   onCategoryClick / onStatusClick (optional) make the status tiles and
   category rows navigate to a filtered Items view. */
export default function AnalyticsView({ c, onCategoryClick, onStatusClick }) {
  const { stats: s, activeItems } = c;
  if (activeItems.length === 0) return <Empty syncing={c.syncing} loaded={c.loaded} />;

  const funnelRows = [
    ["Ordered", s.funnel.ordered, STATUS_HEX.ordered],
    ["Shipped", s.funnel.shipped, STATUS_HEX.shipped],
    ["Delivered", s.funnel.delivered, STATUS_HEX.delivered],
  ];
  const funnelMax = s.funnel.ordered || 1;

  const carrierColor = (i) => (i < CARRIER_HEX.length ? CARRIER_HEX[i] : CARRIER_OTHER_HEX);

  return (
    <div className="space-y-8">
      {/* ---------- hero KPI row ---------- */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <HeroTile label="Total spent (lifetime)" value={fmt(s.spent)}
          sub={`${s.orderCount} order${s.orderCount === 1 ? "" : "s"} · ${s.totalQty} item${s.totalQty === 1 ? "" : "s"}`} />
        <MiniStat label="Saved via discounts" value={fmt(s.saved)} valueCls="text-emerald-700" sub={`${pct(s.avgDisc)} avg off list`} />
        <MiniStat label="Avg delivery time" value={s.avgDeliveryDays != null ? `${s.avgDeliveryDays.toFixed(1)}d` : "—"}
          sub={s.avgDeliveryDays != null ? `from ${s.deliveryDaysSampleSize} delivered order${s.deliveryDaysSampleSize === 1 ? "" : "s"}` : "no carrier delivery data yet"} />
        <MiniStat label="Items tracked" value={String(s.totalQty)} sub="across all active orders" />
      </section>

      {/* ---------- status tiles (kept from original) ---------- */}
      <div className="flex flex-wrap gap-2">
        {s.statuses.map(([st, n]) => (
          <div key={st}
            onClick={onStatusClick ? () => onStatusClick(st) : undefined}
            title={onStatusClick ? "Show these items" : undefined}
            className={`border border-stone-200 rounded-sm px-3 py-2 bg-white ${onStatusClick ? "cursor-pointer hover:border-orange-300 hover:bg-orange-50/40 transition-colors" : ""}`}>
            <StatusChip s={st} /> <span className="mono text-lg font-semibold ml-2">{n}</span>
          </div>
        ))}
      </div>

      {/* ---------- spend over time ---------- */}
      <section>
        <h3 className="disp font-bold text-sm uppercase tracking-wide text-stone-600 mb-2">Spend over time (monthly, charged $)</h3>
        <div className="h-56">
          <ResponsiveContainer>
            <AreaChart data={s.monthData}>
              <defs>
                <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ea580c" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#ea580c" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tickFormatter={monthLabel} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip labelFormatter={monthLabel} formatter={(v, k) => (k === "spend" ? fmt(v) : v)} />
              <Area type="monotone" dataKey="spend" stroke="#ea580c" strokeWidth={2} fill="url(#spendFill)" dot={{ r: 3, fill: "#ea580c", strokeWidth: 0 }} activeDot={{ r: 5 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* ---------- category chart + table (kept from original) ---------- */}
      <section>
        <h3 className="disp font-bold text-sm uppercase tracking-wide text-stone-600 mb-2">Spend by category (paid $)</h3>
        <div className="h-56">
          <ResponsiveContainer>
            <BarChart data={s.catData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => fmt(v)} />
              <Bar dataKey="spend" fill="#ea580c" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <table className="w-full text-sm mt-2">
          <thead className="border-b border-stone-200">
            <tr>
              <th className="py-1 text-left text-xs font-semibold uppercase tracking-wider text-stone-500">Category</th>
              <th className="py-1 text-right text-xs font-semibold uppercase tracking-wider text-stone-500">Items</th>
              <th className="py-1 text-right text-xs font-semibold uppercase tracking-wider text-stone-500">Avg $/item</th>
              <th className="py-1 text-right text-xs font-semibold uppercase tracking-wider text-stone-500">Total paid</th>
            </tr>
          </thead>
          <tbody>
            {s.catData.map((cat) => (
              <tr key={cat.name}
                onClick={onCategoryClick ? () => onCategoryClick(cat.name) : undefined}
                title={onCategoryClick ? `Show ${cat.name} items` : undefined}
                className={`border-b border-stone-100 last:border-0 ${onCategoryClick ? "cursor-pointer hover:bg-orange-50/40 transition-colors" : ""}`}>
                <td className={`py-1 ${onCategoryClick ? "text-blue-600" : ""}`}>{cat.name}</td>
                <td className="py-1 mono text-right">{cat.qty}</td>
                <td className="py-1 mono text-right">{fmt(cat.avgPerItem)}</td>
                <td className="py-1 mono text-right font-semibold">{fmt(cat.spend)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-stone-300">
              <td className="py-1 font-semibold">All categories</td>
              <td className="py-1 mono text-right font-semibold">{s.totalQty}</td>
              <td className="py-1 mono text-right font-semibold">{fmt(s.avgPerItem)}</td>
              <td className="py-1 mono text-right font-semibold">{fmt(s.paid)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* ---------- top items by spend ---------- */}
      <section>
        <h3 className="disp font-bold text-sm uppercase tracking-wide text-stone-600 mb-2">Top items by spend</h3>
        <div className="border border-stone-200 rounded-lg divide-y divide-stone-100 bg-white">
          {s.topItems.map((it, i) => (
            <div key={`${it.orderId}-${i}`} className="flex items-center gap-3 px-3 py-2">
              <span className="mono text-xs text-stone-400 w-4 text-right">{i + 1}</span>
              <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={32}
                onClick={() => it.thumbUrl && c.setLightbox(it.thumbUrl)} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium truncate">{it.name}</div>
                <div className="mono text-[10.5px] text-stone-400">{it.orderId} · {it.category}{it.qty > 1 ? ` · ×${it.qty}` : ""}</div>
              </div>
              <div className="mono text-sm font-semibold text-right shrink-0">{fmt(it.amount)}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- order status funnel ---------- */}
      <section>
        <h3 className="disp font-bold text-sm uppercase tracking-wide text-stone-600 mb-2">Order status funnel</h3>
        {/* Cumulative pipeline: every active order started "ordered"; an
            order currently "delivered" necessarily passed through "shipped"
            first, so shipped/delivered stages count forward, not just the
            orders CURRENTLY sitting in that exact status. */}
        <div className="space-y-1.5 bg-white border border-stone-200 rounded-lg p-3">
          {funnelRows.map(([label, count, color]) => {
            const w = (count / funnelMax) * 100;
            return (
              <div key={label} className="flex items-center gap-3">
                <div className="w-20 text-xs font-semibold text-stone-600 text-right shrink-0">{label}</div>
                <div className="flex-1 bg-stone-100 rounded-sm h-7 overflow-hidden">
                  <div className="h-full rounded-sm flex items-center justify-end pr-2 text-white text-xs font-semibold transition-all"
                    style={{ width: `${Math.max(w, count > 0 ? 6 : 0)}%`, background: color }}>
                    {count > 0 && count}
                  </div>
                </div>
                <div className="w-10 text-xs text-stone-400 text-right shrink-0">{funnelMax ? `${w.toFixed(0)}%` : "—"}</div>
              </div>
            );
          })}
        </div>
        <div className="text-xs text-stone-500 mt-2">
          {s.funnel.cancelled === 0 && s.funnel.returned === 0
            ? "No cancellations or returns."
            : (
              <>
                {s.funnel.cancelled > 0 && <span className="mr-3">✕ {s.funnel.cancelled} cancelled</span>}
                {s.funnel.returned > 0 && <span>↺ {s.funnel.returned} returned</span>}
                <span className="ml-1">(excluded from the funnel above)</span>
              </>
            )}
        </div>
      </section>

      {/* ---------- carrier performance ---------- */}
      <section>
        <h3 className="disp font-bold text-sm uppercase tracking-wide text-stone-600 mb-2">Carrier performance</h3>
        {s.carrierData.length === 0 ? (
          <div className="text-sm text-stone-400 border-2 border-dashed border-stone-200 rounded-lg py-6 text-center">No tracking numbers recorded yet.</div>
        ) : (
          <>
            <div className="h-48">
              <ResponsiveContainer>
                <BarChart data={s.carrierData} layout="vertical" margin={{ left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90} />
                  <Tooltip formatter={(v, k) => (k === "count" ? [`${v} package(s)`, "Packages"] : v)} />
                  <Bar dataKey="count" radius={[0, 2, 2, 0]}>
                    {s.carrierData.map((entry, i) => <Cell key={entry.name} fill={carrierColor(i)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <table className="w-full text-sm mt-2">
              <thead className="border-b border-stone-200">
                <tr>
                  <th className="py-1 text-left text-xs font-semibold uppercase tracking-wider text-stone-500">Carrier</th>
                  <th className="py-1 text-right text-xs font-semibold uppercase tracking-wider text-stone-500">Packages</th>
                  <th className="py-1 text-right text-xs font-semibold uppercase tracking-wider text-stone-500">Avg delivery</th>
                </tr>
              </thead>
              <tbody>
                {s.carrierData.map((cr) => (
                  <tr key={cr.name} className="border-b border-stone-100 last:border-0">
                    <td className="py-1">{cr.name}</td>
                    <td className="py-1 mono text-right">{cr.count}</td>
                    <td className="py-1 mono text-right">{cr.avgDays != null ? `${cr.avgDays.toFixed(1)}d` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-[11px] text-stone-400 mt-1">
              Avg delivery is approximated from the carrier tracker's last-known event time (only populated once Shippo reports a package Delivered) — the app doesn't store a true ship→deliver timestamp per order, only current status.
            </div>
          </>
        )}
      </section>

      {/* ---------- item price distribution ---------- */}
      <section>
        <h3 className="disp font-bold text-sm uppercase tracking-wide text-stone-600 mb-2">Item price distribution</h3>
        <div className="h-48">
          <ResponsiveContainer>
            <BarChart data={s.priceHistogram}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip formatter={(v) => [`${v} item(s)`, "Count"]} />
              <Bar dataKey="count" fill="#44403c" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* ---------- callouts ---------- */}
      <section>
        <h3 className="disp font-bold text-sm uppercase tracking-wide text-stone-600 mb-2">Notable stats</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Callout label="Fastest delivery"
            primary={s.fastestDelivery ? `${s.fastestDelivery.days.toFixed(1)}d` : "—"}
            sub={s.fastestDelivery ? `${s.fastestDelivery.itemName} · ${s.fastestDelivery.carrier}` : "no carrier delivery data yet"} />
          <Callout label="Biggest single discount"
            primary={s.biggestDiscount ? fmt(s.biggestDiscount.amount) : "—"}
            sub={s.biggestDiscount ? `${s.biggestDiscount.name} · ${s.biggestDiscount.orderId}` : "no eligible items"} />
          <Callout label="Priciest item"
            primary={s.priciestItem ? fmt(s.priciestItem.amount) : "—"}
            sub={s.priciestItem ? `${s.priciestItem.name} · ${s.priciestItem.orderId}` : "—"} />
          <Callout label="Busiest month"
            primary={s.busiestMonth ? monthLabel(s.busiestMonth.name) : "—"}
            sub={s.busiestMonth ? `${s.busiestMonth.count} order${s.busiestMonth.count === 1 ? "" : "s"}` : "—"} />
        </div>
      </section>
    </div>
  );
}
