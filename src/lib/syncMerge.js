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

/* Merges two whole app-state blobs. Orders merge per-order (see above);
   processedIds is a plain union (never loses "already processed" info);
   lastSync/autoSync are informational bookkeeping, not safety-critical,
   so they're just taken from whichever side has the newer top-level
   updatedAt. */
export function mergeState(local, remote) {
  const localOrders = local?.orders || [];
  const remoteOrders = remote?.orders || [];
  const orders = mergeOrders(localOrders, remoteOrders);
  const processedIds = Array.from(new Set([...(local?.processedIds || []), ...(remote?.processedIds || [])]));
  const localTs = local?.updatedAt || 0;
  const remoteTs = remote?.updatedAt || 0;
  const preferRemote = remoteTs > localTs;
  return {
    ...(local || {}),
    orders,
    processedIds,
    lastSync: preferRemote ? (remote?.lastSync ?? local?.lastSync ?? null) : (local?.lastSync ?? null),
    autoSync: preferRemote ? (remote?.autoSync ?? local?.autoSync ?? true) : (local?.autoSync ?? true),
    updatedAt: Math.max(localTs, remoteTs),
  };
}
