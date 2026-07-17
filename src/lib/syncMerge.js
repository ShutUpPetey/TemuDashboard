/* ============================================================
   Per-order cloud sync merge.

   WHY THIS EXISTS: the old scheme synced one whole JSON blob with
   "newest updatedAt wins." That meant a STALE device — one that
   hadn't yet seen another device's edit — could save ANYTHING
   (an unrelated status change, the carrier auto-promote effect,
   even just opening the app and auto-syncing) and, because its
   save carries a newer top-level timestamp than the actual edit
   it doesn't know about, clobber that edit wholesale on the next
   pull. This is exactly how a "Try real prices" fix on one device
   could vanish after a refresh on another device.

   THE FIX: every order carries its OWN `updatedAt`, stamped by
   whichever call site actually mutated it (fixEstimatedPrices,
   saveEdit, updateItem, the carrier-promote effect, and the
   order-confirmation/status-email passes in sync()). Merging two
   states never picks one whole side — it takes the UNION of both
   order lists and keeps, per order id, whichever copy has the
   newer per-order timestamp. An edit to order A on device 1 can
   no longer be wiped out by an unrelated save to order B on
   device 2.

   KNOWN LIMITATION: deletions aren't tombstoned. If you delete an
   order on one device before that deletion has synced to another
   device, and the other device saves before pulling the deletion,
   the merge (a union of both order lists) can bring the order
   back. Deletions are rare/manual, so this is an accepted
   trade-off rather than building a full tombstone system.
   ============================================================ */

/* Union of both order lists, keeping the newer per-order copy by id.
   Orders without their own updatedAt yet (pre-migration) sort as 0,
   so any timestamped copy wins over an un-timestamped one. */
export function mergeOrders(localOrders, remoteOrders) {
  const byId = new Map();
  for (const o of localOrders || []) byId.set(o.id, o);
  for (const o of remoteOrders || []) {
    const existing = byId.get(o.id);
    if (!existing || (o.updatedAt || 0) > (existing.updatedAt || 0)) byId.set(o.id, o);
  }
  return Array.from(byId.values());
}

/* True if the merged result has anything remote doesn't (a new order,
   or a newer per-order timestamp) — i.e. remote needs the merged truth
   pushed back to it to converge. */
export function remoteIsStale(mergedOrders, remoteOrders) {
  const remoteById = new Map((remoteOrders || []).map((o) => [o.id, o]));
  return mergedOrders.some((o) => {
    const r = remoteById.get(o.id);
    return !r || (o.updatedAt || 0) > (r.updatedAt || 0);
  });
}

/* Fingerprint comparison (id + updatedAt only, not full content) so the
   live cloud subscriber can cheaply tell "did merging actually change
   anything locally" without a fragile deep-equality check — this is what
   lets it recognize its own echo and skip re-saving in a loop. */
export function sameOrderSet(a, b) {
  const aArr = a || [], bArr = b || [];
  if (aArr.length !== bArr.length) return false;
  const bMap = new Map(bArr.map((o) => [o.id, o.updatedAt || 0]));
  return aArr.every((o) => bMap.get(o.id) === (o.updatedAt || 0));
}

/* ---------- Ratings merge ----------
   Item ratings (see CLAUDE.md "Rate items") live in a separate top-level
   map, keyed `orderId:itemIdx`, and merge the same way orders do: union of
   both sides, newest-per-key wins. Unlike orders, a rating is NEVER
   deleted — clearing a thumb writes verdict:null rather than removing the
   key — so there's no tombstone problem here and "newest ratedAt wins" is
   unconditionally correct. */

/* Union of both ratings maps, newest ratedAt wins per key. Never deletes —
   see above. */
export function mergeRatings(localRatings, remoteRatings) {
  const out = { ...(localRatings || {}) };
  for (const [key, r] of Object.entries(remoteRatings || {})) {
    const existing = out[key];
    if (!existing || (r.ratedAt || 0) > (existing.ratedAt || 0)) out[key] = r;
  }
  return out;
}

/* Fingerprint check (key + ratedAt only) — mirrors sameOrderSet above,
   used to detect "nothing new" without deep-equality. */
export function sameRatingSet(a, b) {
  const aObj = a || {}, bObj = b || {};
  const aKeys = Object.keys(aObj), bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => bObj[k] && bObj[k].ratedAt === aObj[k].ratedAt);
}

/* Mirrors remoteIsStale above — true if the merged ratings have anything
   remote doesn't (new key or newer ratedAt), i.e. remote needs the merge
   pushed back to it. */
export function remoteRatingsStale(mergedRatings, remoteRatings) {
  const remoteObj = remoteRatings || {};
  return Object.entries(mergedRatings || {}).some(([k, r]) => {
    const rem = remoteObj[k];
    return !rem || (r.ratedAt || 0) > (rem.ratedAt || 0);
  });
}

/* ---------- Unmatched-status merge ----------
   `unmatchedStatus` rows ({id, oid, kind, date, trackingNumber}) are status
   emails that couldn't be matched to any stored order — produced by BOTH the
   app's sync/Reconcile and the headless gmail-sync Action, so they must merge
   like everything else or headless findings never reach the app's Review
   queue (and an app save could silently drop the cloud copy).

   Rows are IMMUTABLE per id (same email always yields the same row), so
   there's no per-row timestamp to arbitrate — merge is a plain union by id.
   Instead of tombstones, rows SELF-CLEAN against the merged truth: a row is
   obsolete (and dropped, on every merge, no matter which side still carries
   it) once
     - its `oid` matches an order that now EXISTS in the merged order list
       (the missing order was created/imported somewhere — that's the only
       thing the row was waiting for), or
     - its email `id` is in the merged processedIds (a processed status email
       is by definition matched — unmatched ones are deliberately never
       marked processed, see App.jsx's status pass).
   Every local removal path (Find & import, a Reconcile match) is justified by
   one of these two rules, so the union can never resurrect a cleared row. */
export function mergeUnmatchedStatus(localRows, remoteRows, mergedOrders, mergedProcessedIds) {
  const orderIds = new Set((mergedOrders || []).map((o) => o.id));
  const processed = new Set(mergedProcessedIds || []);
  const byId = new Map();
  for (const r of [...(localRows || []), ...(remoteRows || [])]) {
    if (!r?.id || byId.has(r.id)) continue;           // dedupe by email message id
    if (processed.has(r.id)) continue;                // processed = matched, row obsolete
    if (r.oid && orderIds.has(r.oid)) continue;       // order exists now, row obsolete
    byId.set(r.id, r);
  }
  return Array.from(byId.values());
}

/* Fingerprint check (id set only — rows are immutable per id, see above).
   Mirrors sameOrderSet/sameRatingSet: lets the live subscriber recognize
   "nothing new" without deep equality. Orders/ratings-only checks would
   silently drop an unmatched-only remote change (e.g. a headless run that
   found new unmatched emails but changed nothing else). */
export function sameUnmatchedSet(a, b) {
  const aArr = a || [], bArr = b || [];
  if (aArr.length !== bArr.length) return false;
  const bIds = new Set(bArr.map((r) => r.id));
  return aArr.every((r) => bIds.has(r.id));
}

/* Mirrors remoteIsStale/remoteRatingsStale — true when remote's row set
   differs from the merged one AT ALL: remote missing a row means it hasn't
   seen a new finding; remote HAVING a row the merge dropped means it's
   carrying an obsolete row (self-cleaned above) that a push-back scrubs. */
export function remoteUnmatchedStale(mergedRows, remoteRows) {
  return !sameUnmatchedSet(mergedRows, remoteRows);
}

/* Merges two whole app-state blobs. Orders merge per-order (see above);
   ratings merge per-key (see above); processedIds is a plain union (never
   loses "already processed" info); unmatchedStatus is a union-by-id with
   self-cleaning against the merged orders/processedIds (see above — either
   side may lack the key entirely, old blobs predate it); lastSync/autoSync
   are informational bookkeeping, not safety-critical, so they're just taken
   from whichever side has the newer top-level updatedAt. */
export function mergeState(local, remote) {
  const localOrders = local?.orders || [];
  const remoteOrders = remote?.orders || [];
  const orders = mergeOrders(localOrders, remoteOrders);
  const ratings = mergeRatings(local?.ratings, remote?.ratings);
  const processedIds = Array.from(new Set([...(local?.processedIds || []), ...(remote?.processedIds || [])]));
  // Must be computed AFTER orders/processedIds — self-cleaning judges each
  // row against the MERGED truth, not either side's partial view.
  const unmatchedStatus = mergeUnmatchedStatus(local?.unmatchedStatus, remote?.unmatchedStatus, orders, processedIds);
  const localTs = local?.updatedAt || 0;
  const remoteTs = remote?.updatedAt || 0;
  const preferRemote = remoteTs > localTs;
  return {
    ...(local || {}),
    orders,
    ratings,
    processedIds,
    unmatchedStatus,
    lastSync: preferRemote ? (remote?.lastSync ?? local?.lastSync ?? null) : (local?.lastSync ?? null),
    autoSync: preferRemote ? (remote?.autoSync ?? local?.autoSync ?? true) : (local?.autoSync ?? true),
    updatedAt: Math.max(localTs, remoteTs),
  };
}
