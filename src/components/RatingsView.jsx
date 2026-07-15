import React from "react";
import { ThumbsUp, ThumbsDown, Repeat, CheckCircle2 } from "lucide-react";
import { CropThumb, Empty, RatingButtons, BuyAgainToggle } from "./shared";
import { analyticsItemKey } from "../lib/derive";

/* ============================================================
   "Rate items" — thumbs up/down on delivered items, plus a "buy
   again" flag. Three sections: a to-rate queue (newest-delivered
   first), Liked/Unliked lists, and a buy-again list. Same data on
   both shells (like AnalyticsView/ArrivingSoonView); `mobile` swaps
   in stacked loose sections instead of white-card panels, same
   convention ArrivingSoonView uses for its own strips.

   Ratings are NOT stored on the item objects (see lib/derive.js's
   ratingQueues header comment) — c.ratingQueues is the fully-derived
   { toRate, liked, disliked, buyAgain } read from the top-level
   ratings map, so this view never touches c.ratings directly.
   ============================================================ */
export default function RatingsView({ c, openItem, mobile = false }) {
  const { toRate, liked, disliked, buyAgain } = c.ratingQueues;

  if (c.data.orders.length === 0) return <Empty syncing={c.syncing} loaded={c.loaded} />;

  return (
    <div className={mobile ? "space-y-4" : "space-y-6"}>
      {mobile ? (
        <div className="flex gap-2 overflow-x-auto pb-0.5 -mx-4 px-4">
          <StatPill label="Awaiting" value={String(toRate.length)} />
          <StatPill label="Liked" value={String(liked.length)} valueCls="text-emerald-600" />
          <StatPill label="Unliked" value={String(disliked.length)} valueCls="text-rose-600" />
          <StatPill label="Buy again" value={String(buyAgain.length)} valueCls="text-orange-600" />
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile label="Awaiting rating" value={String(toRate.length)} />
          <StatTile label="Liked" value={String(liked.length)} valueCls="text-emerald-700" />
          <StatTile label="Unliked" value={String(disliked.length)} valueCls="text-rose-700" />
          <StatTile label="Buy again" value={String(buyAgain.length)} valueCls="text-orange-700" />
        </div>
      )}

      {/* Section 1 — Rate recently received */}
      <div>
        <SectionHeader mobile={mobile}>Rate recently received ({toRate.length})</SectionHeader>
        {toRate.length === 0 ? (
          <EmptyBlock icon={CheckCircle2} iconCls="text-emerald-400" text="You're all caught up." sub="Every delivered item has a rating." mobile={mobile} />
        ) : mobile ? (
          <div className="space-y-2">
            {toRate.map((it) => <RateRow key={rowKey(it)} it={it} c={c} openItem={openItem} />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {toRate.map((it) => <RateCard key={rowKey(it)} it={it} c={c} openItem={openItem} />)}
          </div>
        )}
      </div>

      {/* Section 2 — Liked & Unliked, side-by-side on desktop, stacked on mobile */}
      <div className={mobile ? "space-y-4" : "grid grid-cols-1 lg:grid-cols-2 gap-4"}>
        <RatedPanel title="Liked" titleCls="text-emerald-700" rows={liked} c={c} openItem={openItem} mobile={mobile}
          emptyIcon={ThumbsUp} emptyText="No liked items yet." emptySub="Thumbs-up something in the queue above." />
        <RatedPanel title="Unliked" titleCls="text-rose-700" rows={disliked} c={c} openItem={openItem} mobile={mobile}
          emptyIcon={ThumbsDown} emptyText="No unliked items yet." />
      </div>

      {/* Section 3 — Want to buy more (a subset of Liked — buy-again is
          gated on verdict === "up", see App.jsx's toggleBuyAgain) */}
      <RatedPanel title="Want to buy more" rows={buyAgain} c={c} openItem={openItem} mobile={mobile}
        emptyIcon={Repeat} emptyText="Nothing marked yet." emptySub="Tap ↻ Buy again on any liked item to add it here." />
    </div>
  );
}

const rowKey = analyticsItemKey; // rows carry orderId/itemIdx — same key as the ratings map

/* Keyboard activation for the open-sheet click targets below — the
   rating/buy-again controls are real <button>s already, but the row/card
   surfaces are divs and need Enter/Space to match ui-spec's requirement. */
const keyActivate = (fn) => (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
};

function receivedLabel(iso) {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "received today";
  if (days === 1) return "received 1d ago";
  return `received ${days}d ago`;
}

function SectionHeader({ children, mobile }) {
  return (
    <h2 className={`disp text-[13px] font-extrabold uppercase tracking-wide text-stone-600 ${mobile ? "mb-1.5" : "mb-2"}`}>
      {children}
    </h2>
  );
}

function StatTile({ label, value, valueCls = "" }) {
  return (
    <div className="rounded-lg p-4 border bg-white border-stone-200">
      <div className="text-[10px] uppercase tracking-widest font-semibold text-stone-500">{label}</div>
      <div className={`mono text-2xl font-semibold mt-1 ${valueCls}`}>{value}</div>
    </div>
  );
}

function StatPill({ label, value, valueCls = "" }) {
  return (
    <div className="shrink-0 rounded-xl border px-3.5 py-2 min-w-[84px] bg-white border-stone-200">
      <div className="text-[9px] uppercase tracking-widest font-semibold text-stone-500">{label}</div>
      <div className={`mono text-base font-semibold mt-0.5 ${valueCls}`}>{value}</div>
    </div>
  );
}

function EmptyBlock({ icon: Icon, iconCls = "text-stone-300", text, sub, mobile }) {
  return (
    <div className={`text-center py-10 text-stone-400 ${mobile ? "" : "border-2 border-dashed border-stone-200 rounded-sm bg-white"}`}>
      <Icon size={30} className={`mx-auto mb-2 ${iconCls}`} />
      <div className="disp font-bold text-stone-500 text-sm">{text}</div>
      {sub && <div className="text-[12.5px] mt-1">{sub}</div>}
    </div>
  );
}

/* Section 1, desktop: big grid cards, thumbs are the whole point of the
   card so they get their own row below the thumbnail/name (which is the
   tap target for opening the sheet). */
function RateCard({ it, c, openItem }) {
  return (
    <div className="bg-white border border-stone-200 rounded-xl p-3 flex flex-col items-center gap-2 text-center">
      <div onClick={() => openItem(it)} role="button" tabIndex={0} onKeyDown={keyActivate(() => openItem(it))}
        className="cursor-pointer flex flex-col items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 rounded-lg">
        <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={72} rounded="rounded-xl" />
        <div className="text-[13px] font-semibold leading-snug line-clamp-2">{it.name || it.orderId}</div>
        <div className="text-[11px] text-stone-400">{receivedLabel(it.deliveredAt)}</div>
      </div>
      <RatingButtons verdict={it.verdict} size="lg" disabled={c.syncing}
        onUp={() => c.rateItem(it.orderId, it.itemIdx, "up")}
        onDown={() => c.rateItem(it.orderId, it.itemIdx, "down")} />
    </div>
  );
}

/* Section 1, mobile: full-width row, thumbs trail the name — same
   silhouette as ArrivingSoonView's MobileItemCard. */
function RateRow({ it, c, openItem }) {
  return (
    <div className="flex items-center gap-3 bg-white border border-stone-200 rounded-2xl px-3 py-2.5">
      <div onClick={() => openItem(it)} role="button" tabIndex={0} onKeyDown={keyActivate(() => openItem(it))}
        className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 rounded-lg">
        <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={52} rounded="rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold truncate">{it.name || it.orderId}</div>
          <div className="text-[11px] text-stone-400">{receivedLabel(it.deliveredAt)}</div>
        </div>
      </div>
      <RatingButtons verdict={it.verdict} size="sm" disabled={c.syncing}
        onUp={() => c.rateItem(it.orderId, it.itemIdx, "up")}
        onDown={() => c.rateItem(it.orderId, it.itemIdx, "down")} />
    </div>
  );
}

/* Sections 2/3 wrapper — a white PanelHead-style card on desktop, a loose
   titled stack on mobile (PanelHead itself is local to DesktopShell.jsx,
   not exported, so this builds an equivalent header rather than reaching
   into another view file — same choice ArrivingSoonView already made). */
function RatedPanel({ title, titleCls = "text-stone-700", rows, c, openItem, mobile, emptyIcon, emptyText, emptySub }) {
  return (
    <div className={mobile ? "" : "bg-white border border-stone-200 rounded-lg overflow-hidden"}>
      {mobile ? (
        <SectionHeader mobile><span className={titleCls}>{title} ({rows.length})</span></SectionHeader>
      ) : (
        <div className="flex items-center px-4 py-2.5 border-b border-stone-200">
          <h2 className={`disp text-[13px] font-extrabold uppercase tracking-wide ${titleCls}`}>{title} ({rows.length})</h2>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyBlock icon={emptyIcon} text={emptyText} sub={emptySub} mobile={mobile} />
      ) : (
        <div className={mobile ? "space-y-2" : "divide-y divide-stone-100"}>
          {rows.map((it) => <RatedRow key={rowKey(it)} it={it} c={c} openItem={openItem} mobile={mobile} />)}
        </div>
      )}
    </div>
  );
}

/* Compact row for Liked/Unliked/Buy-again — tapping the matching thumb
   here is how you reverse a verdict (tap 👍 in the Liked list → clears;
   tap 👎 → switches straight to Unliked). Buy-again toggle only renders
   for currently-liked rows, gated the same way c.toggleBuyAgain gates
   itself server-side. */
function RatedRow({ it, c, openItem, mobile }) {
  return (
    <div onClick={() => openItem(it)} role="button" tabIndex={0} onKeyDown={keyActivate(() => openItem(it))}
      className={`flex items-center gap-3 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 ${mobile ? "bg-white border border-stone-200 rounded-2xl px-3 py-2.5" : "px-4 py-2.5 hover:bg-orange-50/40"}`}>
      <CropThumb url={it.thumbUrl} y={it.thumbY} rows={it.thumbRows} idx={it.thumbIdx} trustY={it.thumbTrustY} size={mobile ? 40 : 34} rounded="rounded-lg" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate">{it.name || it.orderId}</div>
        <div className="mono text-[10.5px] text-stone-400 truncate">{it.orderId} · {it.category}</div>
      </div>
      <span className="flex items-center gap-1.5 shrink-0">
        <RatingButtons verdict={it.verdict} size="sm" disabled={c.syncing}
          onUp={() => c.rateItem(it.orderId, it.itemIdx, "up")}
          onDown={() => c.rateItem(it.orderId, it.itemIdx, "down")} />
        {it.verdict === "up" && (
          <BuyAgainToggle active={it.buyAgain} disabled={c.syncing} compact
            onToggle={() => c.toggleBuyAgain(it.orderId, it.itemIdx)} />
        )}
      </span>
    </div>
  );
}
