import React, { useState } from "react";
import { Package, Mail, KeyRound, LayoutDashboard, AlertTriangle, X } from "lucide-react";

/* ============================================================
   First-run onboarding tour. Shown automatically once (App.jsx
   checks a "seen" flag in storage); re-launchable anytime from
   Settings via ctx.openWelcome(). Five steps, no persistence of
   its own beyond that one flag — App.jsx owns show/close.
   ============================================================ */

const STEPS = [
  {
    icon: Package,
    title: "Welcome to your Temu manifest",
    body: "This dashboard reads your Temu order emails straight out of Gmail and keeps a running manifest of everything you've bought — item names, prices, statuses, and live shipping ETAs, all in one place.",
  },
  {
    icon: Mail,
    title: "Connect Gmail",
    body: "Sign in with Google to grant read-only access — the app can only read messages, never send or delete anything. Nothing gets sent anywhere except this browser and Anthropic's API, which parses the receipts (next step).",
  },
  {
    icon: KeyRound,
    title: "Add your Anthropic API key",
    body: "Temu's order emails render their receipts as images, not text, so Claude's vision reads the item names and prices straight off the picture. Your key is stored only in this browser's localStorage — it's never sent anywhere but Anthropic.",
  },
  {
    icon: LayoutDashboard,
    title: "Two views, your choice",
    body: "On a bigger screen you get the \"Command Center\" — a sidebar with tables. On a phone, the \"Visual Gallery\" — photo-first cards. It picks automatically by screen size, but Settings → Layout can force either one.",
  },
  {
    icon: AlertTriangle,
    title: "Needs Review",
    body: "Some Temu confirmation emails only give one combined total for several items, so their per-item prices get estimated. The Needs Review queue collects those — plus any status emails the app couldn't match to an order — so you can fix them up, or let the app try to recover the real numbers from a later shipping email.",
  },
];

export default function WelcomeModal({ onClose }) {
  const [step, setStep] = useState(0);
  const last = step === STEPS.length - 1;
  const { icon: Icon, title, body } = STEPS[step];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-md rounded-2xl shadow-2xl relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 text-stone-400 hover:text-stone-600"
        >
          <X size={18} />
        </button>

        <div className="px-6 pt-8 pb-4 text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-orange-50 border border-orange-200 flex items-center justify-center mb-4">
            <Icon size={22} className="text-orange-600" />
          </div>
          <h2 className="disp text-lg font-extrabold text-stone-800 tracking-tight">{title}</h2>
          <p className="text-[13.5px] text-stone-600 mt-2 leading-relaxed">{body}</p>
        </div>

        <div className="flex items-center justify-center gap-1.5 pb-4">
          {STEPS.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              aria-label={`Step ${i + 1} of ${STEPS.length}`}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${i === step ? "bg-orange-500" : "bg-stone-200"}`}
            />
          ))}
        </div>

        <div className="flex items-center gap-2 px-6 pb-6">
          <button onClick={onClose} className="text-xs font-semibold text-stone-400 hover:text-stone-600">
            Skip
          </button>
          <div className="ml-auto flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="border border-stone-300 text-stone-600 text-sm font-bold rounded-xl px-4 py-2"
              >
                Back
              </button>
            )}
            <button
              onClick={() => (last ? onClose() : setStep((s) => s + 1))}
              className="bg-orange-600 hover:bg-orange-500 text-white text-sm font-bold rounded-xl px-5 py-2"
            >
              {last ? "Get started" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
