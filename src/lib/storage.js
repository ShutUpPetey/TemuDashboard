/* ============================================================
   IndexedDB-backed storage (upgraded from localStorage).

   Why IndexedDB: localStorage is capped around 5MB and browsers
   are allowed to evict it under storage pressure. IndexedDB has a
   far larger quota and, combined with navigator.storage.persist(),
   the browser treats this origin's data as durable.

   Keeps the same async {get,set} shape as before (originally the
   Claude-artifact `window.storage` API), so call sites in App.jsx
   don't change. On first read, any existing localStorage data is
   migrated into IndexedDB automatically (the localStorage copy is
   left in place as a last-ditch legacy backup).
   ============================================================ */

const DB_NAME = "temu-manifest";
const STORE = "kv";

let dbPromise = null;
let persistRequested = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB"));
  });
  return dbPromise;
}

function idbGet(key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbSet(key, value) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

// Ask the browser to treat this origin's storage as persistent (not
// evictable under storage pressure). Fire-and-forget; browsers may
// silently decline, which still leaves us no worse off.
function requestPersistence() {
  if (persistRequested) return;
  persistRequested = true;
  try {
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* unsupported browser — fine */
  }
}

export const storage = {
  async get(key) {
    requestPersistence();
    try {
      const v = await idbGet(key);
      if (v != null) return { value: v };
      // One-time migration from the old localStorage backend.
      const legacy = localStorage.getItem(key);
      if (legacy != null) {
        await idbSet(key, legacy).catch(() => {});
        return { value: legacy };
      }
      return null;
    } catch {
      // IndexedDB unavailable (e.g. some private-browsing modes) —
      // fall back to localStorage so the app still works.
      const v = localStorage.getItem(key);
      return v != null ? { value: v } : null;
    }
  },
  async set(key, value) {
    requestPersistence();
    try {
      await idbSet(key, value);
    } catch {
      localStorage.setItem(key, value); // fallback, see get()
    }
    return { key };
  },
};
