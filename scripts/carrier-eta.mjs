/* ============================================================
   Carrier ETA refresher — runs in GitHub Actions on a schedule
   (.github/workflows/carrier-eta.yml), NOT in the browser.

   Talks to carriers DIRECTLY (free developer APIs, no monthly
   shipment caps) and dispatches per tracking number:
   - 1Z…               → UPS Track API   (UPS_CLIENT_ID/SECRET)
   - 9x… (20–26 digit) → USPS Tracking v3 (USPS_CLIENT_ID/SECRET)
   - anything else     → Ship24 / 17TRACK fallback, if a key is set

   Flow: read app state from Firebase RTDB (admin SDK; service
   account in a GitHub secret) → find shipped orders with tracking
   numbers (skip already-Delivered) → poll → write normalized
   records to manifest/{uid}/carrier/{trackingNumber}, a path the
   app only READS.

   Normalized record: { provider, status, subStatus, etaFrom,
   etaTo, eventTime, eventDesc, checkedAt } with status ∈
   InfoReceived | InTransit | OutForDelivery | AvailableForPickup |
   Delivered | DeliveryFailure | Exception | Expired | NotFound
   (what the app's CARRIER_STATUS_LABEL knows).
   ============================================================ */

import admin from "firebase-admin";

const DB_URL = process.env.FIREBASE_DATABASE_URL;
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const SHIPPO_KEY = process.env.SHIPPO_KEY;
const EASYPOST_KEY = process.env.EASYPOST_KEY;
const UPS_ID = process.env.UPS_CLIENT_ID;
const UPS_SECRET = process.env.UPS_CLIENT_SECRET;
const USPS_ID = process.env.USPS_CLIENT_ID;
const USPS_SECRET = process.env.USPS_CLIENT_SECRET;
const SHIP24_KEY = process.env.SHIP24_KEY;
const T17_KEY = process.env.SEVENTEEN_TRACK_KEY;
const MAX_NEW_PER_RUN = Number(process.env.MAX_NEW_PER_RUN || 10);

if (!DB_URL || !SA_JSON) {
  console.error("Missing env: FIREBASE_DATABASE_URL and FIREBASE_SERVICE_ACCOUNT are required.");
  process.exit(1);
}
if (!SHIPPO_KEY && !EASYPOST_KEY && !(UPS_ID && UPS_SECRET) && !(USPS_ID && USPS_SECRET) && !SHIP24_KEY && !T17_KEY) {
  console.error("Missing env: set SHIPPO_KEY (recommended) or other provider credentials.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(SA_JSON)),
  databaseURL: DB_URL,
});
const db = admin.database();

const ymd = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);
const iso10 = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

function detectCarrier(number, hint) {
  const h = (hint || "").toUpperCase();
  if (h.includes("UPS")) return "UPS";
  if (h.includes("USPS")) return "USPS";
  if (h.includes("FEDEX")) return "FedEx";
  if (/^1Z[0-9A-Z]{16}$/i.test(number)) return "UPS";
  if (/^9[2-5]\d{20,25}$/.test(number) || /^\d{20,22}$/.test(number)) return "USPS";
  if (/^\d{12,15}$/.test(number)) return "FedEx";
  return null;
}

/* ---------------- Shippo (preferred: $0.01 per unique tracking number) ----------------
   Free Starter plan includes API access; tracking numbers not created via
   Shippo bill at $0.01 each (once per unique number, polling free). Needs
   an explicit carrier token, so it only handles numbers whose carrier we
   can identify — others fall through to the next adapter. */

const SHIPPO_CARRIER = { UPS: "ups", USPS: "usps", FedEx: "fedex" };
const SHIPPO_STATUS = {
  UNKNOWN: "NotFound",
  PRE_TRANSIT: "InfoReceived",
  TRANSIT: "InTransit",
  DELIVERED: "Delivered",
  RETURNED: "Exception",
  FAILURE: "DeliveryFailure",
};

async function trackShippo(number, carrier) {
  const token = SHIPPO_CARRIER[carrier];
  if (!token) return null; // unknown carrier — let the next adapter try
  const res = await fetch(`https://api.goshippo.com/tracks/${token}/${encodeURIComponent(number)}`, {
    headers: { authorization: `ShippoToken ${SHIPPO_KEY}`, accept: "application/json" },
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Shippo HTTP ${res.status}: ${JSON.stringify(j?.detail || j || "").slice(0, 150)}`);
  const ts = j?.tracking_status || {};
  let status = SHIPPO_STATUS[ts.status] || "NotFound";
  // Shippo has no top-level out-for-delivery status — sniff the substatus/detail.
  if (status === "InTransit" && (/out_for_delivery/i.test(ts.substatus?.code || "") || /out for delivery/i.test(ts.status_details || ""))) {
    status = "OutForDelivery";
  }
  return {
    provider: (j?.carrier || carrier || "carrier").toUpperCase(),
    status,
    subStatus: ts.substatus?.code || null,
    etaFrom: iso10(j?.eta),
    etaTo: iso10(j?.eta),
    eventTime: ts.status_date || null,
    eventDesc: ts.status_details || null,
  };
}

/* ---------------- EasyPost (any carrier, pay-per-tracker) ----------------
   $0.02–0.03 per NEW tracking number; polling an existing tracker is free.
   The tracker id is stored in the carrier record so each number is only
   ever paid for once. */

const EP_STATUS = {
  pre_transit: "InfoReceived",
  in_transit: "InTransit",
  out_for_delivery: "OutForDelivery",
  available_for_pickup: "AvailableForPickup",
  delivered: "Delivered",
  return_to_sender: "Exception",
  failure: "DeliveryFailure",
  cancelled: "Exception",
  error: "Exception",
  unknown: "NotFound",
};

async function epFetch(path, method = "GET", body) {
  const res = await fetch(`https://api.easypost.com/v2/${path}`, {
    method,
    headers: {
      authorization: "Basic " + Buffer.from(`${EASYPOST_KEY}:`).toString("base64"),
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`EasyPost ${path}: HTTP ${res.status} ${JSON.stringify(j?.error || "").slice(0, 150)}`);
  return j;
}

async function trackEasypost(number, carrierHint, existing) {
  let t;
  if (existing.easypostId) {
    t = await epFetch(`trackers/${existing.easypostId}`);
  } else {
    const body = { tracker: { tracking_code: number } };
    if (carrierHint === "UPS" || carrierHint === "USPS" || carrierHint === "FedEx") {
      body.tracker.carrier = carrierHint === "FedEx" ? "FedEx" : carrierHint;
    }
    t = await epFetch("trackers", "POST", body);
  }
  if (!t?.id) throw new Error("EasyPost: no tracker in response");
  const details = t.tracking_details || [];
  const latest = details[details.length - 1] || {};
  return {
    easypostId: t.id,
    provider: t.carrier || carrierHint || "carrier",
    status: EP_STATUS[t.status] || "InTransit",
    subStatus: t.status_detail || null,
    etaFrom: iso10(t.est_delivery_date),
    etaTo: iso10(t.est_delivery_date),
    eventTime: latest.datetime || null,
    eventDesc: latest.message || null,
  };
}

/* ---------------- UPS Track API ---------------- */

let upsToken = null;
async function upsAuth() {
  if (upsToken) return upsToken;
  const res = await fetch("https://onlinetools.ups.com/security/v1/oauth/token", {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${UPS_ID}:${UPS_SECRET}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) throw new Error(`UPS auth failed: HTTP ${res.status}`);
  upsToken = j.access_token;
  return upsToken;
}

function upsStatus(desc) {
  const d = desc || "";
  if (/out for delivery/i.test(d)) return "OutForDelivery";
  if (/delivered/i.test(d)) return "Delivered";
  if (/label|order processed|shipper created/i.test(d)) return "InfoReceived";
  if (/pickup/i.test(d)) return "AvailableForPickup";
  if (/exception|delay|return/i.test(d)) return "Exception";
  return "InTransit";
}

async function trackUps(number) {
  const token = await upsAuth();
  const res = await fetch(`https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(number)}?locale=en_US`, {
    headers: { authorization: `Bearer ${token}`, transId: String(Date.now()), transactionSrc: "temu-manifest" },
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`UPS track HTTP ${res.status}: ${JSON.stringify(j?.response?.errors || "").slice(0, 150)}`);
  const pkg = j?.trackResponse?.shipment?.[0]?.package?.[0];
  if (!pkg) throw new Error("UPS: no package in response");
  const desc = pkg.currentStatus?.description || "";
  // deliveryDate types: SDD scheduled, RDD rescheduled, DEL actual delivery
  const dates = pkg.deliveryDate || [];
  const sched = dates.find((d) => d.type === "RDD") || dates.find((d) => d.type === "SDD") || dates.find((d) => d.type === "DEL");
  const act = pkg.activity?.[0];
  return {
    provider: "UPS",
    status: upsStatus(desc),
    subStatus: pkg.currentStatus?.code || null,
    etaFrom: ymd(sched?.date),
    etaTo: ymd(sched?.date),
    eventTime: act?.date ? `${ymd(act.date)}T${(act.time || "000000").replace(/(\d{2})(\d{2})(\d{2})/, "$1:$2:$3")}` : null,
    eventDesc: act?.status?.description || desc || null,
  };
}

/* ---------------- USPS Tracking v3 ---------------- */

let uspsToken = null;
async function uspsAuth() {
  if (uspsToken) return uspsToken;
  const res = await fetch("https://apis.usps.com/oauth2/v3/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: USPS_ID, client_secret: USPS_SECRET }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) throw new Error(`USPS auth failed: HTTP ${res.status}`);
  uspsToken = j.access_token;
  return uspsToken;
}

function uspsStatus(cat, summary) {
  const s = `${cat || ""} ${summary || ""}`;
  if (/out for delivery/i.test(s)) return "OutForDelivery";
  if (/delivered/i.test(s)) return "Delivered";
  if (/pre-?shipment|label/i.test(s)) return "InfoReceived";
  if (/available for pickup|pickup/i.test(s)) return "AvailableForPickup";
  if (/alert|return/i.test(s)) return "Exception";
  return "InTransit";
}

async function trackUsps(number) {
  const token = await uspsAuth();
  const res = await fetch(`https://apis.usps.com/tracking/v3/tracking/${encodeURIComponent(number)}?expand=DETAIL`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`USPS track HTTP ${res.status}: ${JSON.stringify(j?.error || j || "").slice(0, 150)}`);
  const ev = j?.trackingEvents?.[0];
  return {
    provider: "USPS",
    status: uspsStatus(j?.statusCategory, j?.statusSummary || j?.status),
    subStatus: j?.statusCategory || null,
    etaFrom: iso10(j?.expectedDeliveryDate),
    etaTo: iso10(j?.expectedDeliveryDate),
    eventTime: ev?.eventTimestamp || null,
    eventDesc: ev?.eventType || j?.statusSummary || null,
  };
}

/* ---------------- Ship24 fallback (other carriers) ---------------- */

const SHIP24_STATUS = {
  pending: "NotFound", info_received: "InfoReceived", in_transit: "InTransit",
  out_for_delivery: "OutForDelivery", failed_attempt: "DeliveryFailure",
  available_for_pickup: "AvailableForPickup", delivered: "Delivered", exception: "Exception",
};

async function ship24(path, method, body) {
  const res = await fetch(`https://api.ship24.com/public/v1/${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${SHIP24_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Ship24 ${path}: HTTP ${res.status}`);
  return j?.data || {};
}

async function trackShip24(number, existing, budget) {
  let tracking = null;
  if (existing.trackerId) {
    const data = await ship24(`trackers/${existing.trackerId}/results`, "GET");
    tracking = data.trackings?.[0] || null;
  } else {
    if (budget.n <= 0) return null; // monthly new-tracker quota guard
    budget.n--;
    const data = await ship24("trackers/track", "POST", { trackingNumber: number });
    tracking = data.trackings?.[0] || null;
  }
  if (!tracking) return null;
  const shipment = tracking.shipment || {};
  const latest = (tracking.events || [])[0] || {};
  const eta = shipment?.delivery?.estimatedDeliveryDate || null;
  return {
    trackerId: tracking.tracker?.trackerId || existing.trackerId || null,
    provider: latest.courierCode || "carrier",
    status: SHIP24_STATUS[shipment.statusMilestone] || (shipment.statusMilestone ? "InTransit" : "NotFound"),
    subStatus: shipment.statusCategory || null,
    etaFrom: iso10(eta), etaTo: iso10(eta),
    eventTime: latest.datetime || null,
    eventDesc: latest.status || null,
  };
}

/* ---------------- main ---------------- */

console.log(`Adapters: ${[SHIPPO_KEY && "Shippo", EASYPOST_KEY && "EasyPost", UPS_ID && "UPS", USPS_ID && "USPS", SHIP24_KEY && "Ship24", T17_KEY && "17TRACK"].filter(Boolean).join(", ")}`);

const root = await db.ref("manifest").get();
if (!root.exists()) {
  console.log("No data in RTDB yet — nothing to do.");
  process.exit(0);
}

const ship24Budget = { n: MAX_NEW_PER_RUN };

for (const [uid, node] of Object.entries(root.val() || {})) {
  const stateJson = node?.state?.json;
  if (!stateJson) continue;
  let orders = [];
  try { orders = JSON.parse(stateJson).orders || []; } catch { continue; }
  const carrierNode = node.carrier || {};

  // Daily off-device backup: snapshot the state blob to backups/{YYYY-MM-DD}
  // (idempotent per day — this Action runs every 6h) and prune to the last 7
  // days. Cheap insurance against app-side failure modes (a bad merge, an
  // accidental Clear-all/Full-re-sync propagating through cloud sync) that
  // the manual JSON export only covers when the user remembers to run it.
  // Restore = copy a backup's json back over manifest/{uid}/state.json in
  // the Firebase console, then refresh the app.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const existingBk = node.backups || {};
    if (!existingBk[today]) {
      const backupsRef = db.ref(`manifest/${uid}/backups`);
      await backupsRef.child(today).set({ json: stateJson, savedAt: Date.now() });
      const stale = Object.keys(existingBk).sort();
      for (const d of stale.slice(0, Math.max(0, stale.length - 6))) {
        await backupsRef.child(d).remove();
      }
      console.log(`${uid}: state backed up to backups/${today} (${Math.round(stateJson.length / 1024)} KB).`);
    }
  } catch (e) {
    console.warn(`${uid}: backup failed — ${e.message}`);
  }

  // Shipped orders with tracking numbers, newest first, minus delivered.
  const shipped = orders
    .filter((o) => (o.status || "ordered") === "shipped" && o.tracking?.number)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const jobs = [];
  const seen = new Set();
  for (const o of shipped) {
    const n = String(o.tracking.number).trim();
    if (!/^[A-Za-z0-9]+$/.test(n) || seen.has(n)) continue;
    seen.add(n);
    if (carrierNode[n]?.status === "Delivered") continue;
    jobs.push({ number: n, carrier: detectCarrier(n, o.tracking.carrier) });
  }

  if (!jobs.length) {
    console.log(`${uid}: nothing to poll.`);
    continue;
  }
  console.log(`${uid}: polling ${jobs.length} tracking number(s)…`);

  for (const { number, carrier } of jobs) {
    try {
      // Adapter fall-through: first one that produces a record wins. Each
      // attempt is isolated — an adapter that THROWS (network error, 429)
      // must not kill the chain for this number, only return-null does the
      // documented fall-through otherwise.
      const attempt = async (name, fn) => {
        try { return await fn(); }
        catch (e) { console.warn(`  ${number}: ${name} errored (${e.message}) — trying next adapter`); return null; }
      };
      let rec = null;
      if (SHIPPO_KEY) rec = await attempt("Shippo", () => trackShippo(number, carrier));
      if (!rec && EASYPOST_KEY) rec = await attempt("EasyPost", () => trackEasypost(number, carrier, carrierNode[number] || {}));
      if (!rec && carrier === "UPS" && UPS_ID && UPS_SECRET) rec = await attempt("UPS", () => trackUps(number));
      if (!rec && carrier === "USPS" && USPS_ID && USPS_SECRET) rec = await attempt("USPS", () => trackUsps(number));
      if (!rec && SHIP24_KEY) rec = await attempt("Ship24", () => trackShip24(number, carrierNode[number] || {}, ship24Budget));
      if (!rec) { console.log(`  ${number}: no adapter result (${carrier || "unknown carrier"}) — skipped`); continue; }
      await db.ref(`manifest/${uid}/carrier/${number}`).update({ registered: true, ...rec, checkedAt: Date.now() });
      console.log(`  ${number} (${rec.provider}): ${rec.status} eta=${rec.etaFrom || "?"}`);
    } catch (e) {
      console.warn(`  ${number}: ${e.message}`);
    }
  }
}

console.log("Done.");
process.exit(0);
