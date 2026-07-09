/* ============================================================
   Direct Gmail REST API access (replaces the Claude.ai Gmail MCP
   connector). All calls are simple authenticated GETs using the
   OAuth token from gis.js.
   ============================================================ */

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmailFetch(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail API ${res.status}: ${text}`.slice(0, 300));
  }
  return res.json();
}

// Returns [{id, threadId}, ...] — Gmail's search endpoint only returns IDs,
// so callers need a follow-up metadata/full fetch for subject/date/body.
// Paginates through Gmail's `nextPageToken` (each page maxes out at 500
// results) until either the results run out or `maxResults` is reached.
// A small `maxResults` (e.g. 1, used by the connection test) naturally stops
// after the first page without over-fetching.
export async function searchMessages(query, token, maxResults = 2000) {
  const results = [];
  let pageToken = null;
  do {
    const remaining = maxResults - results.length;
    const pageSize = Math.max(1, Math.min(500, remaining));
    const params = new URLSearchParams({ q: query, maxResults: String(pageSize) });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gmailFetch(`/messages?${params.toString()}`, token);
    results.push(...(data.messages || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken && results.length < maxResults);
  return results;
}

export async function getMessageMetadata(id, token) {
  return gmailFetch(
    `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`,
    token
  );
}

export async function getMessageFull(id, token) {
  return gmailFetch(`/messages/${id}?format=full`, token);
}

export function headerValue(message, name) {
  const h = message.payload?.headers?.find(
    (x) => x.name.toLowerCase() === name.toLowerCase()
  );
  return h?.value || "";
}

function b64urlDecode(data) {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  // Gmail body data is UTF-8; atob gives us a binary string, so re-decode as UTF-8.
  const binary = atob(b64 + pad);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

// Walks MIME parts to find the text/html body of a message.
export function extractHtml(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return b64urlDecode(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const html = extractHtml(part);
      if (html) return html;
    }
  }
  return "";
}

// Temu's order emails mark the two sections that matter with HTML comments,
// e.g. "<!-- @@goods_list begin@@ -->...<!-- @@goods_list end@@ -->". Everything
// else (recommended-for-you ads, marketing banners) should be ignored.
export function extractSection(html, name) {
  const re = new RegExp(
    `<!--\\s*@@${name}\\s+begin@@\\s*-->([\\s\\S]*?)<!--\\s*@@${name}\\s+end@@\\s*-->`,
    "i"
  );
  const m = html.match(re);
  return m ? m[1] : "";
}

// Same as extractSection, but returns EVERY match instead of just the first.
// Needed for split-order emails ("Your Temu orders confirmation" — plural),
// where Temu bundles several orders into one message and each one gets its
// own goods_list image section, in document order.
export function extractAllSections(html, name) {
  const re = new RegExp(
    `<!--\\s*@@${name}\\s+begin@@\\s*-->([\\s\\S]*?)<!--\\s*@@${name}\\s+end@@\\s*-->`,
    "gi"
  );
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function stripTags(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Some Temu order-confirmation emails bundle several orders into one message
// ("Your purchase has been divided into N orders."). Each sub-order has its
// own plain-text "Order ID: PO-..." line and its own pre-computed
// "Order total $X.XX" line (no colon). The COMBINED total across every
// sub-order shows up later as "Order total: $X.XX" (with a colon) inside the
// image-rendered payment summary — that one is intentionally excluded here.
// For a normal single-order email this returns a single {orderId, total}
// entry (harmless — callers only use this path when more than one is found).
export function extractSubOrders(html) {
  const text = stripTags(html);
  const ids = [...text.matchAll(/Order ID:\s*(PO-[\d-]+)/g)].map((m) => m[1]);
  const totalMatches = [...text.matchAll(/Order total(:)?\s*\$?([\d,]+\.\d{2})/gi)];
  const perOrderTotals = totalMatches.filter((m) => !m[1]).map((m) => parseFloat(m[2].replace(/,/g, "")));
  return ids.map((id, i) => ({ orderId: id, total: perOrderTotals[i] ?? null }));
}

// Extracts <img src="..."> values from an HTML fragment, preserving the full
// query string (Temu's image URLs are signed with a long-lived `sign=` param).
export function extractImgSrcs(sectionHtml) {
  const srcs = [];
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(sectionHtml))) srcs.push(m[1]);
  return srcs;
}

// Pulls a Temu PO number (e.g. "PO-211-...") out of a subject line or body text.
export function extractPoNumber(text) {
  const m = (text || "").match(/PO-[\d-]+/);
  return m ? m[0] : null;
}

// PO number for a STATUS email whose subject didn't carry one. The body of a
// split-purchase status email can mention SIBLING orders' POs, so "first PO
// in the raw HTML" mis-attributes statuses. The tracking-button link carries
// parent_order_sn=PO-... for exactly the order the email is about — prefer
// that, fall back to the first PO in the visible text.
export function extractPoFromBody(html) {
  const m = (html || "").match(/parent_order_sn=(PO-[\d-]+)/i);
  if (m) return m[1];
  return extractPoNumber(stripTags(html || ""));
}

// Carrier tracking info from a Temu shipping email: the direct UPS/USPS/
// FedEx link if present, plus the tracking number (recognized by carrier
// number formats). Falls back to building the canonical tracking URL from
// the number when only the number is present.
export function extractTracking(html) {
  const hrefs = [];
  const re = /<a[^>]+href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html || ""))) hrefs.push(m[1].replace(/&amp;/g, "&"));
  const find = (host) => hrefs.find((u) => new RegExp(`^https?://[^/]*${host}`, "i").test(u));
  let carrier = null;
  let url = null;
  if ((url = find("ups\\.com"))) carrier = "UPS";
  else if ((url = find("usps\\.com"))) carrier = "USPS";
  else if ((url = find("fedex\\.com"))) carrier = "FedEx";

  const text = stripTags(html || "");
  const number =
    text.match(/\b(1Z[0-9A-Z]{16})\b/)?.[1] ||                        // UPS
    text.match(/\b(9[2-5]\d{20,25})\b/)?.[1] ||                       // USPS
    text.match(/tracking (?:number|no\.?|#)[:\s]*([A-Z0-9]{10,34})/i)?.[1] ||
    null;
  if (!carrier && number) {
    carrier = number.startsWith("1Z") ? "UPS" : /^9[2-5]/.test(number) ? "USPS" : /^\d{12,15}$/.test(number) ? "FedEx" : null;
  }
  if (!url && number) {
    if (carrier === "UPS") url = `https://www.ups.com/track?tracknum=${number}`;
    else if (carrier === "USPS") url = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${number}`;
    else if (carrier === "FedEx") url = `https://www.fedex.com/fedextrack/?trknbr=${number}`;
  }
  return number || url ? { carrier, number, url } : null;
}

// The orange "view order / track" button in Temu emails links to
// app.temu.com/cmsg_transit.html?..._order_ticket=...&parent_order_sn=PO-...
// — that's the real order-detail link. Other links in the email (change
// address, help, etc.) can ALSO contain the PO number, so matching by PO
// alone picks wrong; the _order_ticket/cmsg_transit signature is what
// identifies the right one.
export function isOrderDetailLink(url) {
  return /cmsg_transit\.html|_order_ticket=/i.test(url || "");
}

// Finds the order-detail link for this PO in a Temu email. Ranking:
// 1) cmsg_transit/_order_ticket links carrying this PO (the orange button)
// 2) any cmsg_transit/_order_ticket link (single-order emails)
// 3) other temu.com links that look order-related and aren't address/account
export function extractOrderLink(html, poId) {
  const hrefs = [];
  const re = /<a[^>]+href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html || ""))) hrefs.push(m[1].replace(/&amp;/g, "&"));
  const temu = hrefs.filter(
    (u) => /^https?:\/\/[^/]*temu\.com/i.test(u) && !/unsubscribe|preference|privacy|support|help|address/i.test(u)
  );
  const pool = poId ? temu.filter((u) => u.includes(poId)) : [];
  const ranked = pool.length ? pool : temu;
  return (
    ranked.find((u) => isOrderDetailLink(u)) ||
    temu.find((u) => isOrderDetailLink(u)) ||
    ranked.find((u) => /order|track|logistic|parcel|package/i.test(u)) ||
    null
  );
}

// Pulls an estimated-arrival window out of an email's plain text, e.g.
// "Estimated delivery: Jul 10 - Jul 15" or "arriving by Aug 2". Returns the
// raw human-readable date string (kept verbatim — Temu's wording varies) or
// null. Cheap regex only, no Claude call.
const MON = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?";
const DATE_RANGE = `${MON}\\s*\\d{1,2}(?:\\s*[-–—]\\s*(?:${MON}\\s*)?\\d{1,2})?`;
export function extractEta(html) {
  const text = stripTags(html || "");
  const patterns = [
    new RegExp(`(?:estimated|expected)\\s+(?:delivery|arrival)[^A-Za-z0-9]{0,12}(${DATE_RANGE})`, "i"),
    new RegExp(`(?:arriv\\w+|deliver\\w+)\\s+(?:by|between|on|:)?\\s*(${DATE_RANGE})`, "i"),
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

// Best-effort parse of an eta string's END date ("Jul 10 - Jul 15" → Jul 15)
// into an ISO date, for sorting/urgency. Year is inferred: the nearest
// occurrence of that month/day around `around` (default now), so a December
// email mentioning "Jan 3" lands in the next year.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function etaEndDate(eta, around = new Date()) {
  if (!eta) return null;
  const parts = [...eta.matchAll(new RegExp(`(${MON})?\\s*(\\d{1,2})`, "gi"))].filter((m) => m[2]);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  let monStr = last[1];
  if (!monStr) {
    const first = parts.find((p) => p[1]);
    monStr = first ? first[1] : null;
  }
  if (!monStr) return null;
  const mon = MONTHS.indexOf(monStr.slice(0, 3).toLowerCase());
  const day = Number(last[2]);
  if (mon < 0 || !day || day > 31) return null;
  const candidates = [-1, 0, 1].map((dy) => new Date(around.getFullYear() + dy, mon, day));
  candidates.sort((a, b) => Math.abs(a - around) - Math.abs(b - around));
  return candidates[0].toISOString().slice(0, 10);
}
