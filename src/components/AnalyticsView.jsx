import React from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { fmt, StatusChip, Empty } from "./shared";

/* Analytics charts + tables — identical content on both shells.
   onCategoryClick / onStatusClick (optional) make the status tiles and
   category rows navigate to a filtered Items view. */
export default function AnalyticsView({ c, onCategoryClick, onStatusClick }) {
  const { stats, activeItems } = c;
  if (activeItems.length === 0) return <Empty syncing={c.syncing} />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {stats.statuses.map(([s, n]) => (
          <div key={s}
            onClick={onStatusClick ? () => onStatusClick(s) : undefined}
            title={onStatusClick ? "Show these items" : undefined}
            className={`border border-stone-200 rounded-sm px-3 py-2 bg-white ${onStatusClick ? "cursor-pointer hover:border-orange-300 hover:bg-orange-50/40 transition-colors" : ""}`}>
            <StatusChip s={s} /> <span className="mono text-lg font-semibold ml-2">{n}</span>
          </div>
        ))}
      </div>
      <section>
        <h3 className="disp font-bold text-sm uppercase tracking-wide text-stone-600 mb-2">Spend by category (paid $)</h3>
        <div className="h-56">
          <ResponsiveContainer>
            <BarChart data={stats.catData}>
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
            {stats.catData.map((cat) => (
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
              <td className="py-1 mono text-right font-semibold">{stats.totalQty}</td>
              <td className="py-1 mono text-right font-semibold">{fmt(stats.avgPerItem)}</td>
              <td className="py-1 mono text-right font-semibold">{fmt(stats.paid)}</td>
            </tr>
          </tbody>
        </table>
      </section>
      <section>
        <h3 className="disp font-bold text-sm uppercase tracking-wide text-stone-600 mb-2">Monthly spend (charged $)</h3>
        <div className="h-56">
          <ResponsiveContainer>
            <BarChart data={stats.monthData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => fmt(v)} />
              <Bar dataKey="spend" fill="#44403c" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
