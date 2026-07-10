import React, { useEffect, useMemo } from "react";
import { ShieldCheck, X, RefreshCw, Package } from "lucide-react";
import { fmt, StatusChip } from "./shared";

/* Admin-only view: lists every registered user (from manifest/_directory,
   which every signed-in user stamps their own entry into — see
   lib/firebase.js) and lets the admin open a READ-ONLY snapshot of any
   one user's data. Firebase rules are what actually keep this admin-only
   and everyone else's data private from each other (see README → "Admin
   access") — this component has no enforcement of its own, it just won't
   get any data back if the rules reject the request.

   Deliberately separate from the main `data`/`save()` state in App.jsx:
   nothing here is ever written back anywhere, so there's no path by which
   viewing another user's orders could corrupt either their data or the
   admin's own. */
export default function AdminPanel({ c }) {
  useEffect(() => {
    if (!c.directory) c.loadDirectory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (c.adminViewUid) return <ViewingUser c={c} />;

  const entries = useMemo(() => Object.entries(c.directory || {}), [c.directory]);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-200">
          <h2 className="disp font-bold text-sm uppercase tracking-wide text-stone-600">Registered users</h2>
          <button onClick={c.loadDirectory} className="ml-auto text-stone-400 hover:text-stone-700"><RefreshCw size={13} /></button>
        </div>
        {c.directoryError && (
          <div className="px-4 py-3 text-sm text-red-600 bg-red-50">
            Couldn't load the directory: {c.directoryError}. If this is unexpected, check that the Firebase rules from
            README → "Admin access" are actually pasted into the Firebase console.
          </div>
        )}
        {!c.directoryError && c.directory && entries.length === 0 && (
          <div className="px-4 py-6 text-sm text-stone-400 text-center">No one has signed in with cloud sync yet.</div>
        )}
        {entries.map(([uid, info]) => (
          <div key={uid} className="flex items-center gap-3 px-4 py-3 border-b border-stone-100 last:border-0 text-sm">
            <span className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-300 to-orange-500 grid place-items-center text-white text-xs font-bold shrink-0">
              {(info.email || "?").slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="font-medium truncate">{info.email || uid}</div>
              <div className="mono text-[11px] text-stone-400 truncate">{uid}</div>
            </div>
            <div className="ml-auto text-xs text-stone-400 shrink-0">
              {info.lastSeen ? `last seen ${new Date(info.lastSeen).toLocaleDateString()}` : ""}
            </div>
            <button onClick={() => c.viewUserData(uid)}
              className="shrink-0 text-blue-600 hover:text-blue-500 font-semibold text-xs">
              View data →
            </button>
          </div>
        ))}
      </div>
      <div className="text-xs text-stone-400 max-w-xl leading-relaxed">
        Each account's orders live only under that account's own cloud path — this directory and the read-only viewer
        are the only way anyone (including admin) sees across accounts, and Firebase rules restrict both to the admin
        email configured in <span className="mono">VITE_ADMIN_EMAIL</span>.
      </div>
    </div>
  );
}

function ViewingUser({ c }) {
  const orders = c.adminViewState?.orders || [];
  const sorted = useMemo(() => [...orders].sort((a, b) => (b.date || "").localeCompare(a.date || "")), [orders]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-900 text-sm font-medium px-4 py-2.5 rounded-lg">
        <ShieldCheck size={15} className="shrink-0" />
        Viewing {c.directory?.[c.adminViewUid]?.email || c.adminViewUid}'s data — read-only, nothing here can be edited or synced.
        <button onClick={c.exitAdminView} className="ml-auto inline-flex items-center gap-1 text-amber-900/70 hover:text-amber-900 font-semibold">
          <X size={14} /> Exit
        </button>
      </div>

      {c.adminViewLoading && <div className="text-sm text-stone-400 px-1">Loading…</div>}

      {!c.adminViewLoading && sorted.length === 0 && (
        <div className="text-center py-16 text-stone-400 border-2 border-dashed border-stone-200 rounded-sm">
          <Package size={36} className="mx-auto mb-3 text-stone-300" />
          <div className="disp font-bold text-stone-500">No orders</div>
          <div className="text-sm mt-1">This account hasn't synced any Temu orders yet.</div>
        </div>
      )}

      {!c.adminViewLoading && sorted.length > 0 && (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 border-b border-stone-200">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-stone-500">Order</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-stone-500">Date</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-stone-500">Status</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-stone-500">Items</th>
                <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-stone-500">Total</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((o) => (
                <tr key={o.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2 mono text-xs">{o.id}</td>
                  <td className="px-3 py-2 text-stone-500">{o.date}</td>
                  <td className="px-3 py-2"><StatusChip s={o.status || "ordered"} /></td>
                  <td className="px-3 py-2 text-stone-500">{(o.items || []).map((i) => i.name).join(", ")}</td>
                  <td className="px-3 py-2 mono text-right font-semibold">{fmt(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
