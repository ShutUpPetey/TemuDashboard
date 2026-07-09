/* ============================================================
   Carrier ETA refresher — runs in GitHub Actions on a schedule
   (.github/workflows/carrier-eta.yml), NOT in the browser.

   Provider-agnostic: uses whichever tracking API key is present.
   - SHIP24_KEY          → Ship24 (free plan: ~10 NEW shipments/mo,
                           personal email OK; polling existing
                           trackers is free)
   - SEVENTEEN_TRACK_KEY → 17TRACK (one-time 200 registrations,
                           requires business email to sign up)

   Flow:
   1. Read app state from Firebase RTDB (admin SDK, service-account
      JSON in a GitHub secret).
   2. Find shipped orders with tracking numbers (skip ones already
      reported Delivered). Newest orders first, so if a quota runs
      out it's the oldest shipments that miss out.
   3. Register/track via the provider, normalize the result, write
      to manifest/{uid}/carrier/{trackingNumber} — a path the app
      only READS (no write race with the app's state blob).

   Normalized record: { registered, trackerId?, provider, status,
   subStatus, etaFrom, etaTo, eventTime, eventDesc, checkedAt }
   status ∈ InfoReceived | InTransit | OutForDelivery |
   AvailableForPickup | Delivered | DeliveryFailure | Exception |
   Expired | NotFound  (what the app's CARRIER_STATUS_LABEL knows)
   ============================================================ */

import admin from "firebase-admin";

const DB_URL = process.env.FIREBASE_DATABASE_URL;
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const SHIP24_KEY = process.env.SHIP24_KEY;
const T17_KEY = process.env.SEVENTEEN_TRACK_KEY;
const MAX_NEW_PER_RUN = Number(process.env.MAX_NEW_PER_RUN || 10);

if (!DB_URL || !SA_JSON) {
  console.error("Missing env: FIREBASE_DATABASE_URL and FIREBASE_SERVICE_ACCOUNT are required.");
  process.exit(1);
}
if (!SHIP24_KEY && !T17_KEY) {
  console.error("Missing env: set SHIP24_KEY or SEVENTEEN_TRACK_KEY.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(SA_JSON)),
  databaseURL: DB_URL,
});
const db = admin.database();

/* ---------------- Ship24 adapter ---------------- */

const SHIP24_STATUS = {
  pending: "NotFound",
  info_received: "InfoReceived",
  in_transit: "InTransit",
  out_for_delivery: "OutForDelivery",
  failed_attempt: "DeliveryFailure",
  available_for_pickup: "AvailableForPickup",
  delivered: "Delivered",
  exception: "Exception",
};

async function ship24(path, method, body) {
  const res = await fetch(`https://api.ship24.com/public/v1/${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${SHIP24_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Ship24 ${path}: HTTP ${res.status} ${JSON.stringify(j?.errors || j || "").slice(0, 200)}`);
  return j?.data || {};
}

function normalizeShip24(tracking) {
  const shipment = tracking?.shipment || {};
  const events = tracking?.events || [];
  const latest = events[0] || {};
  const eta = shipment?.delivery?.estimatedDeliveryDate || null;
  return {
    provider: latest.courierCode || shipment?.originCountryCode || "carrier",
    status: SHIP24_STATUS[shipment.statusMilestone] || (shipment.statusMilestone ? "InTransit" : "NotFound"),
    subStatus: shipment.statusCategory || null,
    etaFrom: eta,
    etaTo: eta,
    eventTime: latest.datetime || null,
    eventDesc: latest.status || null,
  };
}

async function pollShip24(uid, numbers, carrierNode) {
  // New numbers: "track once" creates a tracker + returns results (this is
  // what consumes the monthly quota). Existing: fetch results by trackerId.
  let newBudget = MAX_NEW_PER_RUN;
  for (const n of numbers) {
    const existing = carrierNode[n] || {};
    try {
      let tracking = null;
      if (existing.trackerId) {
        const data = await ship24(`trackers/${existing.trackerId}/results`, "GET");
        tracking = data.trackings?.[0] || null;
      } else {
        if (newBudget <= 0) { console.log(`  ${n}: skipped (new-tracker budget spent)`); continue; }
        newBudget--;
        const data = await ship24("trackers/track", "POST", { trackingNumber: n });
        tracking = data.trackings?.[0] || null;
      }
      if (!tracking) { console.warn(`  ${n}: no tracking payload`); continue; }
      const rec = normalizeShip24(tracking);
      await db.ref(`manifest/${uid}/carrier/${n}`).update({
        registered: true,
        trackerId: tracking.tracker?.trackerId || existing.trackerId || null,
        ...rec,
        checkedAt: Date.now(),
      });
      console.log(`  ${n}: ${rec.status} eta=${rec.etaFrom || "?"}`);
    } catch (e) {
      console.warn(`  ${n}: Ship24 error — ${e.message}`);
    }
  }
}

/* ---------------- 17TRACK adapter ---------------- */

async function api17(path, body) {
  const res = await fetch(`https://api.17track.net/track/v2.2/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "17token": T17_KEY },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => null);
  if (!j || j.code !== 0) throw new Error(`17TRACK ${path} failed: ${j ? `code ${j.code}` : `HTTP ${res.status}`}`);
  return j.data || {};
}

async function poll17track(uid, numbers, carrierNode) {
  const toRegister = numbers.filter((n) => !carrierNode[n]?.registered).slice(0, MAX_NEW_PER_RUN);
  if (toRegister.length) {
    try {
      const reg = await api17("register", toRegister.map((number) => ({ number })));
      const ok = new Set((reg.accepted || []).map((a) => a.number));
      for (const r of reg.rejected || []) {
        if (/already|exist/i.test(r.error?.message || "") || r.error?.code === -18019901) ok.add(r.number);
        else console.warn(`  register rejected ${r.number}:`, r.error?.code, r.error?.message);
      }
      for (const n of ok) await db.ref(`manifest/${uid}/carrier/${n}/registered`).set(true);
    } catch (e) {
      console.warn(`  register call failed — ${e.message}`);
    }
  }
  try {
    const info = await api17("gettrackinfo", numbers.map((number) => ({ number })));
    for (const a of info.accepted || []) {
      const t = a.track_info || {};
      const eta = t.time_metrics?.estimated_delivery_date || {};
      const ev = t.latest_event || {};
      await db.ref(`manifest/${uid}/carrier/${a.number}`).update({
        registered: true,
        provider: t.tracking?.providers?.[0]?.provider?.name || null,
        status: t.latest_status?.status || null,
        subStatus: t.latest_status?.sub_status || null,
        etaFrom: eta.from || null,
        etaTo: eta.to || null,
        eventTime: ev.time_iso || ev.time_utc || null,
        eventDesc: ev.description || null,
        checkedAt: Date.now(),
      });
      console.log(`  ${a.number}: ${t.latest_status?.status || "?"} eta=${eta.from || "?"}..${eta.to || "?"}`);
    }
    for (const r of info.rejected || []) console.warn(`  gettrackinfo rejected ${r.number}:`, r.error?.code, r.error?.message);
  } catch (e) {
    console.warn(`  gettrackinfo failed — ${e.message}`);
  }
}

/* ---------------- main ---------------- */

const providerName = SHIP24_KEY ? "Ship24" : "17TRACK";
console.log(`Provider: ${providerName}`);

const root = await db.ref("manifest").get();
if (!root.exists()) {
  console.log("No data in RTDB yet — nothing to do.");
  process.exit(0);
}

for (const [uid, node] of Object.entries(root.val() || {})) {
  const stateJson = node?.state?.json;
  if (!stateJson) continue;
  let orders = [];
  try { orders = JSON.parse(stateJson).orders || []; } catch { continue; }
  const carrierNode = node.carrier || {};

  // Shipped orders with tracking numbers, newest first (quota priority),
  // minus ones the carrier already reported delivered.
  const shipped = orders
    .filter((o) => (o.status || "ordered") === "shipped" && o.tracking?.number)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const numbers = [...new Set(
    shipped.map((o) => String(o.tracking.number).trim()).filter((n) => /^[A-Za-z0-9]+$/.test(n))
  )].filter((n) => carrierNode[n]?.status !== "Delivered");

  if (!numbers.length) {
    console.log(`${uid}: nothing to poll.`);
    continue;
  }
  console.log(`${uid}: polling ${numbers.length} tracking number(s)…`);
  if (SHIP24_KEY) await pollShip24(uid, numbers, carrierNode);
  else await poll17track(uid, numbers, carrierNode);
}

console.log("Done.");
process.exit(0);
