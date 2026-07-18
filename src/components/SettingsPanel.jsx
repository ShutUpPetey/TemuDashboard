import React, { useEffect, useRef, useState } from "react";
import { Download, Upload, LogIn, LogOut, HelpCircle } from "lucide-react";
import { claudeVia } from "../lib/anthropic";

/* Settings content shared by both shells.
   `dark` renders the desktop (dark sidebar-app) styling; the mobile
   sheet uses light styling. All handlers come from ctx (App.jsx). */
export default function SettingsPanel({ c, dark = true }) {
  const importInputRef = useRef(null);
  // Which path callClaude would take right now (async — needs a Firebase
  // ID token probe). Re-checked when cloud sign-in state or the pasted
  // key changes; null while probing.
  const [claudeMode, setClaudeMode] = useState(null);
  useEffect(() => {
    let alive = true;
    claudeVia().then((m) => { if (alive) setClaudeMode(m); }).catch(() => { if (alive) setClaudeMode("none"); });
    return () => { alive = false; };
  }, [c.cloudState, c.apiKeyInput]);
  const label = dark ? "text-stone-400" : "text-stone-500";
  const btn = dark
    ? "inline-flex items-center gap-1 text-stone-300 hover:text-white text-xs border border-stone-600 px-2 py-1 rounded-sm transition-colors"
    : "inline-flex items-center gap-1 text-stone-600 hover:text-stone-900 text-xs border border-stone-300 px-2 py-1 rounded-sm transition-colors";
  const link = (color) => `${color} underline underline-offset-2 text-sm`;
  const row = `flex flex-wrap items-center gap-3 pt-3 border-t ${dark ? "border-stone-700" : "border-stone-200"}`;

  return (
    <div className={`flex flex-col gap-3 text-sm ${dark ? "text-stone-300" : "text-stone-700"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!c.data.autoSync}
            onChange={(e) => c.save({ ...c.data, autoSync: e.target.checked })} />
          Auto-check on open (if &gt;12h old)
        </label>
        <button onClick={() => c.sync(false, { wide: true })} disabled={c.syncing}
          title="Searches your full Gmail history and adds back any order that's missing — including deleted sub-orders from split emails — without touching what you already have. Hand-edited orders are never overwritten."
          className={link(dark ? "text-blue-400 hover:text-blue-300" : "text-blue-600 hover:text-blue-500")}>
          Reconcile with Gmail
        </button>
        <button
          onClick={() => {
            if (confirm(
              "Full re-sync WIPES all stored orders — including manual edits and recovered prices — and re-reads everything from Gmail (many vision calls, several minutes).\n\n" +
              "If something just looks out of date, cancel and use Reconcile instead: it only adds what's missing and never overwrites your edits.\n\nContinue with the destructive full re-sync?"
            )) c.sync(true);
          }}
          disabled={c.syncing}
          title="Destructive: clears every stored order (manual edits included) and re-reads your whole Gmail history from scratch. Reconcile is the safe option."
          className={link(dark ? "text-orange-400 hover:text-orange-300" : "text-orange-600 hover:text-orange-500")}>
          Full re-sync
        </button>
        <button
          onClick={async () => {
            if (confirm(
              "Clear ALL stored orders?\n\nWith cloud sync on, the empty state also pushes to Firebase — your other devices will sync to empty too. Consider Export JSON first."
            )) await c.save({ orders: [], processedIds: [], lastSync: null, autoSync: c.data.autoSync, ratings: {} });
          }}
          className={link(dark ? "text-red-400 hover:text-red-300" : "text-red-600 hover:text-red-500")}>
          Clear all data
        </button>
      </div>

      <div className={row}>
        <span className={`${label} text-xs uppercase tracking-wide`}>Google</span>
        {c.googleSignedIn ? (
          <>
            <span className="text-emerald-500 text-xs">Signed in</span>
            <button onClick={c.handleGoogleSignOut} className={btn}><LogOut size={12} /> Sign out</button>
          </>
        ) : (
          <button onClick={c.handleGoogleSignIn} className={btn}><LogIn size={12} /> Sign in with Google</button>
        )}
        <button onClick={c.testConnection} disabled={c.syncing} className={btn}>Test connection</button>
      </div>

      <div className={row}>
        <span className={`${label} text-xs uppercase tracking-wide`}>Cloud sync</span>
        {c.cloudState === "unconfigured" && (
          <span className={`${label} text-xs`}>Not set up — add the VITE_FIREBASE_* values to .env (see README → Cloud sync) to share data across devices.</span>
        )}
        {c.cloudState === "off" && <span className={`${label} text-xs`}>Configured — reconnects automatically on open; if this persists, sign in with Google above.</span>}
        {c.cloudState === "connecting" && <span className="text-amber-500 text-xs">Connecting…</span>}
        {c.cloudState === "on" && <span className="text-emerald-500 text-xs">● Live — this device syncs through Firebase</span>}
        {c.cloudState === "error" && <span className="text-red-400 text-xs">Connection failed — data stays local. See the sync log and README → Cloud sync.</span>}
      </div>

      <div className={row}>
        <span className={`${label} text-xs uppercase tracking-wide`}>Notifications</span>
        {!c.pushConfigured ? (
          <span className={`${label} text-xs`}>
            Not set up — add VITE_FIREBASE_MESSAGING_SENDER_ID and VITE_FIREBASE_VAPID_KEY (see docs/phone-app-setup.md).
          </span>
        ) : c.pushNeedsInstall ? (
          <span className={`${label} text-xs`}>
            On iPhone/iPad, install the app first: Share → “Add to Home Screen”, then enable notifications here (iOS 16.4+).
          </span>
        ) : c.pushSupport === false ? (
          <span className={`${label} text-xs`}>This browser doesn't support web push notifications.</span>
        ) : c.cloudState !== "on" ? (
          <span className={`${label} text-xs`}>Sign in with Google above first — notification devices are registered to your cloud account.</span>
        ) : (
          <>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!c.pushEnabled}
                disabled={c.pushBusy || c.pushSupport !== true}
                onChange={c.togglePush}
              />
              Push notifications on this device
            </label>
            {c.pushBusy && <span className="text-amber-500 text-xs">Working…</span>}
            {!c.pushBusy && c.pushEnabled && <span className="text-emerald-500 text-xs">● Registered</span>}
          </>
        )}
      </div>

      <div className={row}>
        <span className={`${label} text-xs uppercase tracking-wide`}>Anthropic API key</span>
        {claudeMode === "proxy" && (
          <span className="text-emerald-500 text-xs">● Using shared cloud key via relay (signed in)</span>
        )}
        <input
          type="password"
          value={c.apiKeyInput}
          onChange={(e) => c.setApiKeyInput(e.target.value)}
          onBlur={(e) => c.saveApiKey(e.target.value.trim())}
          placeholder={claudeMode === "proxy" ? "sk-ant-… (optional fallback)" : "sk-ant-…"}
          className={`border rounded-sm px-2 py-1 text-xs w-56 mono ${dark ? "bg-stone-800 border-stone-600 text-stone-100" : "bg-white border-stone-300 text-stone-800"}`}
        />
        <span className={`${label} text-[11px]`}>
          {claudeMode === "proxy"
            ? "optional fallback — the relay's key is used while you're signed in"
            : "stored only in this browser"}
        </span>
      </div>

      <div className={row}>
        <span className={`${label} text-xs uppercase tracking-wide`}>Layout</span>
        {[["auto", "Auto"], ["desktop", "Desktop"], ["mobile", "Mobile"]].map(([v, l]) => (
          <button key={v} onClick={() => c.setLayoutOverride(v)}
            className={`${btn} ${c.layoutOverride === v ? (dark ? "!text-orange-400 !border-orange-500/60" : "!text-orange-700 !border-orange-400") : ""}`}>
            {l}
          </button>
        ))}
        <span className={`${label} text-[11px]`}>Auto picks by screen width — override to force either shell</span>
      </div>

      <div className={row}>
        <span className={`${label} text-xs uppercase tracking-wide`}>Item photo size</span>
        <input type="range" min="28" max="140" step="4" value={c.thumbSize}
          onChange={(e) => c.updateThumbSize(Number(e.target.value))} className="w-40" />
        <span className="mono text-xs">{c.thumbSize}px</span>
        {[36, 64, 96].map((sz) => (
          <button key={sz} onClick={() => c.updateThumbSize(sz)} className={btn}>
            {sz === 36 ? "S" : sz === 64 ? "M" : "L"}
          </button>
        ))}
      </div>

      <div className={row}>
        <span className={`${label} text-xs uppercase tracking-wide`}>Backup</span>
        <button onClick={c.exportData} className={btn}><Download size={12} /> Export JSON</button>
        <button onClick={() => importInputRef.current?.click()} className={btn}><Upload size={12} /> Import JSON</button>
        <input ref={importInputRef} type="file" accept="application/json" className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && confirm("Importing REPLACES all current data with this backup file (and pushes it to the cloud if sync is on). Continue?")) c.importData(f);
            e.target.value = "";
          }} />
        <span className={dark ? "text-stone-600" : "text-stone-300"}>·</span>
        <button onClick={c.exportItemsCsv} className={btn}><Download size={12} /> Items CSV</button>
        <button onClick={c.exportOrdersCsv} className={btn}><Download size={12} /> Orders CSV</button>
        <span className={`${label} text-[11px]`}>JSON = full backup · CSV = for Excel/Sheets</span>
      </div>

      <div className={row}>
        <span className={`${label} text-xs uppercase tracking-wide`}>Help</span>
        <button onClick={c.openWelcome} className={btn}><HelpCircle size={12} /> Show welcome tour</button>
      </div>
    </div>
  );
}
